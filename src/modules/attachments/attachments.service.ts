import { createHash, randomUUID } from 'crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { accessibleBy } from '@casl/prisma';
import {
  Attachment,
  AttachmentKind,
  Prisma,
  RepairStatus,
} from '@prisma/client';
import type { AuthUser } from '../../auth/account-check';
import {
  AppAbility,
  canViewCosts,
} from '../../auth/permissions/ability.factory';
import { PrismaService } from '../../shared/prisma.service';
import { SettingsService } from '../../settings/settings.service';
import { whoName } from '../vrms/audit-events';
import { readableTickets } from '../vrms/ticket-access';
import { isFinished, STATUS_LABELS } from '../vrms/ticket-statuses';
import { DOCUMENT_KINDS, KIND_RULES, visibleKinds } from './attachment-kinds';
import {
  fileTooLarge,
  fileTypeNotAllowed,
  fileUnreadable,
  forbiddenKind,
  issueNotOnTicket,
  noFile,
  documentLimitReached,
  photoLimitReached,
  ticketFinished,
} from './attachment-errors';
import { UploadAttachmentDto } from './dto/upload-attachment.dto';
import { isImageType, sniffType, TYPE_NAMES } from './file-sniff';
import {
  attachmentKeys,
  FILE_STORE,
  type FileStore,
  linkWindow,
  StorageUnavailableException,
} from './file-store';
import { processImage, UnreadableImageError } from './image-pipeline';

const MB = 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type UploadedFile = { buffer: Buffer; originalname: string };

export type AttachmentView = {
  id: string;
  kind: AttachmentKind;
  issueId: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  uploadedBy: { id: string; name: string };
  createdAt: Date;
  url: string;
  thumbnailUrl: string | null;
  canRemove: boolean;
};

type Ticket = { id: string; repairStatus: RepairStatus };

/** The bytes ready to store, after the pipeline. */
type Prepared = {
  body: Buffer;
  thumbnail: Buffer | null;
  ext: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  fileName: string;
};

/** The upload's name: path parts and control characters removed, trimmed, cut to 255 (data model). */
export function cleanFileName(original: string, ext: string, forceExt = false) {
  const last = original.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  let name = last.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (forceExt && name) {
    const dot = name.lastIndexOf('.');
    name = `${dot > 0 ? name.slice(0, dot) : name}.${ext}`;
  }
  if (!name) name = `file.${ext}`;
  if (name.length > 255) {
    const suffix = `.${ext}`;
    name = name.endsWith(suffix)
      ? name.slice(0, 255 - suffix.length) + suffix
      : name.slice(0, 255);
  }
  return name;
}

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

// Spec 0017: the rules, the transaction and the links for ticket attachments.
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORE) private readonly store: FileStore,
    private readonly settings: SettingsService,
  ) {}

  /** AC-5 and AC-9: the three upload settings, read on every request. */
  limits() {
    return {
      maxFileMb: this.settings.get('uploads.max_file_mb'),
      maxVehiclePhotos: this.settings.get('uploads.max_vehicle_photos'),
      maxDocuments: this.settings.get('uploads.max_documents'),
    };
  }

  /** AC-16: the ticket when the caller may read it, else 404. */
  async findVisibleTicket(ability: AppAbility, id: string): Promise<Ticket> {
    const scope = readableTickets(ability);
    const ticket =
      scope && UUID.test(id)
        ? await this.prisma.repairTicket.findFirst({
            where: { id, AND: [scope] },
            select: { id: true, repairStatus: true },
          })
        : null;
    if (!ticket) throw new NotFoundException('Repair ticket not found');
    return ticket;
  }

  /** AC-15: the add right for this kind on this ticket. */
  async canAdd(
    ability: AppAbility,
    ticketId: string,
    kind: AttachmentKind,
  ): Promise<boolean> {
    const rule = KIND_RULES[kind];
    if (rule.costsOnly && !canViewCosts(ability)) return false;
    if (!ability.can(rule.addAction, 'RepairTicket')) return false;
    const found = await this.prisma.repairTicket.count({
      where: {
        id: ticketId,
        AND: [accessibleBy(ability, rule.addAction).ofType('RepairTicket')],
      },
    });
    return found > 0;
  }

  async list(ticketId: string, ability: AppAbility) {
    this.requireStore();
    const ticket = await this.findVisibleTicket(ability, ticketId);
    const kinds = visibleKinds(canViewCosts(ability));
    const now = new Date();

    const [rows, vehiclePhotoCount, documentCount, addFiles, addDocuments] =
      await Promise.all([
        this.prisma.attachment.findMany({
          where: {
            repairTicketId: ticketId,
            kind: { in: kinds },
            deletedAt: null,
            purgedAt: null,
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        this.liveCount(this.prisma, ticketId, ['VEHICLE_PHOTO']),
        this.liveCount(this.prisma, ticketId, DOCUMENT_KINDS),
        this.canAdd(ability, ticketId, 'VEHICLE_PHOTO'),
        this.canAdd(ability, ticketId, 'OTHER_DOCUMENT'),
      ]);

    const open = !isFinished(ticket.repairStatus);
    const items = await Promise.all(rows.map((row) => this.view(row, now)));

    return {
      items,
      urlsExpireAt: linkWindow(now).expiresOn,
      limits: {
        ...this.limits(),
        vehiclePhotoCount,
        documentCount: canViewCosts(ability) ? documentCount : 0,
      },
      kinds: kinds.map((kind) => ({
        kind,
        label: KIND_RULES[kind].label,
        accepts: KIND_RULES[kind].accepts,
        acceptsLabel: KIND_RULES[kind].acceptsLabel,
      })),
      can: {
        addFiles: open && addFiles,
        addDocuments: open && addDocuments,
      },
    };
  }

  /** AC-4 to AC-14: one file onto one ticket. Answers the view and whether it was a duplicate. */
  async upload(
    ticketId: string,
    file: UploadedFile | undefined,
    dto: UploadAttachmentDto,
    user: AuthUser,
    ability: AppAbility,
  ): Promise<{ attachment: AttachmentView; duplicate: boolean }> {
    this.requireStore();
    const ticket = await this.findVisibleTicket(ability, ticketId);
    const rule = KIND_RULES[dto.kind];
    const limits = this.limits();

    // AC-12b: the first failing check wins, in this order
    if (!(await this.canAdd(ability, ticketId, dto.kind))) {
      throw forbiddenKind();
    }
    if (isFinished(ticket.repairStatus)) {
      throw ticketFinished(STATUS_LABELS[ticket.repairStatus]);
    }
    if (file && file.buffer.length > limits.maxFileMb * MB) {
      throw fileTooLarge(
        limits.maxFileMb,
        `${(file.buffer.length / MB).toFixed(1)} MB`,
      );
    }
    if (!file || file.buffer.length === 0) throw noFile();

    const type = sniffType(file.buffer);
    if (!type || !rule.accepts.includes(type)) {
      throw fileTypeNotAllowed(
        rule.label,
        rule.acceptsLabel,
        type ? TYPE_NAMES[type] : 'not a recognised type',
      );
    }
    if (dto.issueId) await this.checkIssue(this.prisma, ticketId, dto);

    const sha256 = sha256Hex(file.buffer);
    const existing = await this.findDuplicate(
      this.prisma,
      ticketId,
      dto.kind,
      sha256,
    );
    if (existing) {
      return {
        attachment: await this.view(existing, new Date()),
        duplicate: true,
      };
    }
    await this.checkCaps(this.prisma, ticketId, dto.kind, limits);

    const prepared = await this.prepare(file, type);
    const id = randomUUID();
    const keys = attachmentKeys(
      ticketId,
      id,
      prepared.ext,
      Boolean(prepared.thumbnail),
    );
    const written: string[] = [];

    try {
      // AC-14: blobs before the insert, so a row never points at nothing
      await this.store.put({
        key: keys.storageKey,
        body: prepared.body,
        contentType: prepared.mimeType,
        fileName: prepared.fileName,
      });
      written.push(keys.storageKey);
      if (keys.thumbnailKey && prepared.thumbnail) {
        await this.store.put({
          key: keys.thumbnailKey,
          body: prepared.thumbnail,
          contentType: 'image/webp',
          fileName: prepared.fileName.replace(/\.[^.]*$/, '') + '.webp',
        });
        written.push(keys.thumbnailKey);
      }

      const result = await this.prisma.$transaction(
        async (tx) => {
          await this.lockOpenTicket(tx, ticketId);
          if (dto.issueId) await this.checkIssue(tx, ticketId, dto);
          const duplicate = await this.findDuplicate(
            tx,
            ticketId,
            dto.kind,
            sha256,
          );
          if (duplicate) return { row: duplicate, duplicate: true };
          await this.checkCaps(tx, ticketId, dto.kind, limits);

          const row = await tx.attachment.create({
            data: {
              id,
              repairTicketId: ticketId,
              issueId:
                dto.kind === 'VEHICLE_PHOTO' ? (dto.issueId ?? null) : null,
              kind: dto.kind,
              storageKey: keys.storageKey,
              thumbnailKey: keys.thumbnailKey,
              fileName: prepared.fileName,
              mimeType: prepared.mimeType,
              sizeBytes: prepared.body.length,
              width: prepared.width,
              height: prepared.height,
              sha256,
              uploadedByUserId: user.sub,
              uploadedByName: whoName(user),
            },
          });
          return { row, duplicate: false };
        },
        { timeout: 10_000 },
      );

      if (result.duplicate) await this.deleteBlobs(written);
      return {
        attachment: await this.view(result.row, new Date()),
        duplicate: result.duplicate,
      };
    } catch (error) {
      await this.deleteBlobs(written);
      // AC-8: the partial unique index is only a backstop, caught outside the aborted transaction
      if (isUniqueViolation(error)) {
        const row = await this.findDuplicate(
          this.prisma,
          ticketId,
          dto.kind,
          sha256,
        );
        if (row)
          return {
            attachment: await this.view(row, new Date()),
            duplicate: true,
          };
      }
      throw error;
    }
  }

  /** AC-6 and AC-7: the bytes that get stored. No uploaded bytes are stored unchanged. */
  private async prepare(
    file: UploadedFile,
    type: NonNullable<ReturnType<typeof sniffType>>,
  ): Promise<Prepared> {
    if (!isImageType(type)) {
      // The PDF pipeline lands with documents (milestone 5)
      throw fileUnreadable();
    }
    try {
      const image = await processImage(file.buffer, type);
      return {
        body: image.display,
        thumbnail: image.thumbnail,
        ext: 'jpg',
        mimeType: image.mimeType,
        width: image.width,
        height: image.height,
        fileName: cleanFileName(file.originalname, 'jpg', true),
      };
    } catch (error) {
      if (error instanceof UnreadableImageError) throw fileUnreadable();
      throw error;
    }
  }

  /** AC-9 and AC-10: locks the ticket row (never writes it, AC-13) and checks it is still open. */
  private async lockOpenTicket(tx: Prisma.TransactionClient, ticketId: string) {
    const [locked] = await tx.$queryRaw<
      { id: string; repair_status: RepairStatus }[]
    >`SELECT id, repair_status FROM repair_tickets WHERE id = ${ticketId}::uuid FOR NO KEY UPDATE`;
    if (!locked) throw new NotFoundException('Repair ticket not found');
    if (isFinished(locked.repair_status)) {
      throw ticketFinished(STATUS_LABELS[locked.repair_status]);
    }
  }

  /** AC-11: issueId only with a vehicle photo, and only an issue on this ticket. */
  private async checkIssue(
    db: Prisma.TransactionClient,
    ticketId: string,
    dto: UploadAttachmentDto,
  ) {
    if (dto.kind !== 'VEHICLE_PHOTO') throw issueNotOnTicket();
    const found = await db.repairIssue.count({
      where: { id: dto.issueId, repairTicketId: ticketId },
    });
    if (!found) throw issueNotOnTicket();
  }

  private findDuplicate(
    db: Prisma.TransactionClient,
    ticketId: string,
    kind: AttachmentKind,
    sha256: string,
  ) {
    return db.attachment.findFirst({
      where: { repairTicketId: ticketId, kind, sha256, deletedAt: null },
    });
  }

  private liveCount(
    db: Prisma.TransactionClient,
    ticketId: string,
    kinds: AttachmentKind[],
  ) {
    return db.attachment.count({
      where: { repairTicketId: ticketId, kind: { in: kinds }, deletedAt: null },
    });
  }

  private async checkCaps(
    db: Prisma.TransactionClient,
    ticketId: string,
    kind: AttachmentKind,
    limits: ReturnType<AttachmentsService['limits']>,
  ) {
    if (kind === 'VEHICLE_PHOTO') {
      const count = await this.liveCount(db, ticketId, ['VEHICLE_PHOTO']);
      if (count >= limits.maxVehiclePhotos) {
        throw photoLimitReached(limits.maxVehiclePhotos);
      }
    } else if (DOCUMENT_KINDS.includes(kind)) {
      const count = await this.liveCount(db, ticketId, DOCUMENT_KINDS);
      if (count >= limits.maxDocuments) {
        throw documentLimitReached(limits.maxDocuments);
      }
    }
  }

  private async view(row: Attachment, now: Date): Promise<AttachmentView> {
    const [url, thumbnailUrl] = await Promise.all([
      this.store.readUrl(row.storageKey, row.fileName, row.mimeType, now),
      row.thumbnailKey
        ? this.store.readUrl(
            row.thumbnailKey,
            row.fileName.replace(/\.[^.]*$/, '') + '.webp',
            'image/webp',
            now,
          )
        : Promise.resolve(null),
    ]);
    return {
      id: row.id,
      kind: row.kind,
      issueId: row.issueId,
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      width: row.width,
      height: row.height,
      uploadedBy: { id: row.uploadedByUserId, name: row.uploadedByName },
      createdAt: row.createdAt,
      url,
      thumbnailUrl,
      // Milestone 3 computes this from AC-17
      canRemove: false,
    };
  }

  private async deleteBlobs(keys: string[]) {
    for (const key of keys) {
      try {
        await this.store.delete(key);
      } catch (error) {
        // The orphan sweep (AC-19) removes it after 24 hours
        this.logger.warn(`Could not delete blob ${key}: ${String(error)}`);
      }
    }
  }

  /** AC-3: every attachment route answers 503 while storage is not configured. */
  requireStore() {
    if (!this.store.configured) throw new StorageUnavailableException();
  }
}
