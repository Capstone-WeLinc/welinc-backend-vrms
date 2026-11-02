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
import {
  attachmentAddedEvent,
  attachmentRemovedEvent,
  auditData,
  whoName,
} from '../vrms/audit-events';
import { workStarted } from '../vrms/apply-status-move';
import { readableTickets } from '../vrms/ticket-access';
import { isFinished, STATUS_LABELS } from '../vrms/ticket-statuses';
import {
  type AddAction,
  DOCUMENT_KINDS,
  isPhotoKind,
  KIND_RULES,
  PHOTO_KINDS,
  PHOTO_RULE,
  photoKindFor,
  visibleKinds,
} from './attachment-kinds';
import {
  attachmentNotFound,
  fileTooLarge,
  fileEncrypted,
  fileTypeNotAllowed,
  fileUnreadable,
  pdfTooManyPages,
  pdfUnreadable,
  forbiddenKind,
  issueNotOnTicket,
  noFile,
  notYourFile,
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
import {
  EncryptedPdfError,
  MAX_PDF_PAGES,
  PdfPageCountError,
  processPdf,
  UnreadablePdfError,
} from './pdf-pipeline';

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

type Ticket = {
  id: string;
  repairStatus: RepairStatus;
  workStartedAt: Date | null;
};

/** The ticket row as read under its lock. */
type LockedTicket = { repairStatus: RepairStatus; workStartedAt: Date | null };

/** What AC-17's remove rule reads, worked out once per request. */
export type RemoveRights = {
  userId: string;
  /** The ticket is in an open status (AC-10). */
  open: boolean;
  removeAny: boolean;
  /** The add right for each add action on this ticket (AC-15), documents including costs. */
  add: Record<AddAction, boolean>;
};

/**
 * Spec 0017, AC-17: anyone with ticket.files.remove_any removes any file they can see; the
 * uploader removes their own while they still hold the add right for its kind. Never on a
 * finished ticket.
 */
export function canRemove(
  row: Pick<Attachment, 'kind' | 'uploadedByUserId'>,
  rights: RemoveRights,
): boolean {
  if (!rights.open) return false;
  if (rights.removeAny) return true;
  return (
    row.uploadedByUserId === rights.userId &&
    rights.add[KIND_RULES[row.kind].addAction]
  );
}

function attachmentRef(row: Pick<Attachment, 'id' | 'kind' | 'fileName'>) {
  return {
    id: row.id,
    kind: row.kind,
    kindLabel: KIND_RULES[row.kind].label,
    fileName: row.fileName,
  };
}

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

  /** AC-5 and AC-9 (spec 0018, AC-3): the upload settings, read on every request. */
  limits() {
    return {
      maxFileMb: this.settings.get('uploads.max_file_mb'),
      maxVehiclePhotos: this.settings.get('uploads.max_vehicle_photos'),
      maxAfterPhotos: this.settings.get('uploads.max_after_photos'),
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
            select: { id: true, repairStatus: true, workStartedAt: true },
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

  async list(ticketId: string, user: AuthUser, ability: AppAbility) {
    this.requireStore();
    const ticket = await this.findVisibleTicket(ability, ticketId);
    const kinds = visibleKinds(canViewCosts(ability));
    const now = new Date();

    const [
      rows,
      vehiclePhotoCount,
      afterPhotoCount,
      documentCount,
      addFiles,
      addDocuments,
    ] = await Promise.all([
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
      this.liveCount(this.prisma, ticketId, ['PROOF']),
      this.liveCount(this.prisma, ticketId, DOCUMENT_KINDS),
      this.canAdd(ability, ticketId, 'VEHICLE_PHOTO'),
      this.canAdd(ability, ticketId, 'OTHER_DOCUMENT'),
    ]);

    const open = !isFinished(ticket.repairStatus);
    const rights: RemoveRights = {
      userId: user.sub,
      open,
      removeAny: ability.can('removeAny', 'RepairTicket'),
      add: { addFiles, addDocuments },
    };
    const items = await Promise.all(
      rows.map((row) => this.view(row, now, canRemove(row, rights))),
    );

    return {
      items,
      urlsExpireAt: linkWindow(now).expiresOn,
      limits: {
        ...this.limits(),
        vehiclePhotoCount,
        afterPhotoCount,
        documentCount: canViewCosts(ability) ? documentCount : 0,
      },
      // Spec 0018: the web uploads photos as PHOTO, so the two photo kinds show as one entry
      kinds: [
        { kind: 'PHOTO' as const, ...PHOTO_RULE },
        ...kinds
          .filter((kind) => !isPhotoKind(kind))
          .map((kind) => ({
            kind,
            label: KIND_RULES[kind].label,
            accepts: KIND_RULES[kind].accepts,
            acceptsLabel: KIND_RULES[kind].acceptsLabel,
          })),
      ],
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
    // Spec 0018, AC-1: a photo's kind comes from whether work has started, never from the
    // client. This early kind is checked now; it is derived again under the lock below.
    const photo = dto.kind === 'PHOTO' || isPhotoKind(dto.kind);
    const earlyKind: AttachmentKind = photo
      ? photoKindFor(workStarted(ticket))
      : (dto.kind as AttachmentKind);
    const rule = photo ? PHOTO_RULE : KIND_RULES[earlyKind];
    const limits = this.limits();

    // AC-12b: the first failing check wins, in this order
    if (!(await this.canAdd(ability, ticketId, earlyKind))) {
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
    // Spec 0018: photos no longer carry an issue tag, so a photo's issueId is ignored; a
    // document never took one (spec 0017, AC-11)
    if (dto.issueId && !photo) throw issueNotOnTicket();

    // AC-17 here: the caller just passed the add check on an open ticket
    const removeAny = ability.can('removeAny', 'RepairTicket');
    const answer = async (row: Attachment, duplicate: boolean) => ({
      attachment: await this.view(
        row,
        new Date(),
        removeAny || row.uploadedByUserId === user.sub,
      ),
      duplicate,
    });

    const sha256 = sha256Hex(file.buffer);
    const existing = await this.findDuplicate(
      this.prisma,
      ticketId,
      earlyKind,
      sha256,
    );
    if (existing) return answer(existing, true);
    await this.checkCaps(this.prisma, ticketId, earlyKind, limits);

    const prepared = await this.prepare(file, type);
    const id = randomUUID();
    const keys = attachmentKeys(
      ticketId,
      id,
      prepared.ext,
      Boolean(prepared.thumbnail),
    );
    const written: string[] = [];
    let kind = earlyKind;

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
          const locked = await this.lockOpenTicket(tx, ticketId);
          // Spec 0018, AC-1: the kind again from the locked row; the checks below run for it
          kind = photo ? photoKindFor(workStarted(locked)) : earlyKind;
          const duplicate = await this.findDuplicate(
            tx,
            ticketId,
            kind,
            sha256,
          );
          if (duplicate) return { row: duplicate, duplicate: true };
          await this.checkCaps(tx, ticketId, kind, limits);

          const now = new Date();
          const row = await tx.attachment.create({
            data: {
              id,
              createdAt: now,
              repairTicketId: ticketId,
              issueId: null,
              kind,
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
          // AC-18: the audit row in the same transaction (lock order: ticket, attachment, audit)
          await tx.auditLog.create({
            data: {
              repairTicketId: ticketId,
              ...auditData(user, attachmentAddedEvent(attachmentRef(row)), now),
            },
          });
          return { row, duplicate: false };
        },
        { timeout: 10_000 },
      );

      if (result.duplicate) await this.deleteBlobs(written);
      return answer(result.row, result.duplicate);
    } catch (error) {
      await this.deleteBlobs(written);
      // AC-8: the partial unique index is only a backstop, caught outside the aborted transaction
      if (isUniqueViolation(error)) {
        const row = await this.findDuplicate(
          this.prisma,
          ticketId,
          kind,
          sha256,
        );
        if (row) return answer(row, true);
      }
      throw error;
    }
  }

  /**
   * AC-17: soft delete. Error order (AC-12b): 404 ticket or attachment not visible, 204 when
   * already deleted, 403 NOT_YOUR_FILE, 409 TICKET_FINISHED (again under the row lock).
   */
  async remove(
    ticketId: string,
    attachmentId: string,
    user: AuthUser,
    ability: AppAbility,
  ): Promise<void> {
    this.requireStore();
    const ticket = await this.findVisibleTicket(ability, ticketId);
    const row = await this.prisma.attachment.findFirst({
      where: {
        id: attachmentId,
        repairTicketId: ticketId,
        // A receipt or other document is 404 without ticket.costs.view (AC-16)
        kind: { in: visibleKinds(canViewCosts(ability)) },
      },
    });
    if (!row) throw attachmentNotFound();
    if (row.deletedAt) return;

    const mayRemove =
      ability.can('removeAny', 'RepairTicket') ||
      (row.uploadedByUserId === user.sub &&
        (await this.canAdd(ability, ticketId, row.kind)));
    if (!mayRemove) throw notYourFile();
    if (isFinished(ticket.repairStatus)) {
      throw ticketFinished(STATUS_LABELS[ticket.repairStatus]);
    }

    const now = new Date();
    await this.prisma.$transaction(
      async (tx) => {
        await this.lockOpenTicket(tx, ticketId);
        // Only a live row changes, so a second remove racing this one writes nothing (idempotent)
        const { count } = await tx.attachment.updateMany({
          where: { id: row.id, deletedAt: null },
          data: {
            deletedAt: now,
            deletedByUserId: user.sub,
            deletedByName: whoName(user),
          },
        });
        if (count === 0) return;
        await tx.auditLog.create({
          data: {
            repairTicketId: ticketId,
            ...auditData(user, attachmentRemovedEvent(attachmentRef(row)), now),
          },
        });
      },
      { timeout: 10_000 },
    );
  }

  /** AC-6 and AC-7: the bytes that get stored. No uploaded bytes are stored unchanged. */
  private async prepare(
    file: UploadedFile,
    type: NonNullable<ReturnType<typeof sniffType>>,
  ): Promise<Prepared> {
    if (!isImageType(type)) {
      try {
        const pdf = await processPdf(file.buffer);
        return {
          body: pdf.body,
          thumbnail: null,
          ext: 'pdf',
          mimeType: pdf.mimeType,
          width: null,
          height: null,
          fileName: cleanFileName(file.originalname, 'pdf', true),
        };
      } catch (error) {
        if (error instanceof EncryptedPdfError) throw fileEncrypted();
        if (error instanceof PdfPageCountError) {
          throw pdfTooManyPages(MAX_PDF_PAGES, error.pageCount);
        }
        if (error instanceof UnreadablePdfError) throw pdfUnreadable();
        throw error;
      }
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

  /**
   * AC-9 and AC-10: locks the ticket row (never writes it, AC-13) and checks it is still open.
   * Answers the locked status and work start (spec 0018), the values every check under the lock reads.
   */
  private async lockOpenTicket(
    tx: Prisma.TransactionClient,
    ticketId: string,
  ): Promise<LockedTicket> {
    const [locked] = await tx.$queryRaw<
      {
        id: string;
        repair_status: RepairStatus;
        work_started_at: Date | null;
      }[]
    >`SELECT id, repair_status, work_started_at FROM repair_tickets WHERE id = ${ticketId}::uuid FOR NO KEY UPDATE`;
    if (!locked) throw new NotFoundException('Repair ticket not found');
    if (isFinished(locked.repair_status)) {
      throw ticketFinished(STATUS_LABELS[locked.repair_status]);
    }
    return {
      repairStatus: locked.repair_status,
      workStartedAt: locked.work_started_at,
    };
  }

  /** AC-8, and spec 0018 AC-21: Before and After are one pool, so a photo matches either kind. */
  private findDuplicate(
    db: Prisma.TransactionClient,
    ticketId: string,
    kind: AttachmentKind,
    sha256: string,
  ) {
    return db.attachment.findFirst({
      where: {
        repairTicketId: ticketId,
        kind: { in: isPhotoKind(kind) ? PHOTO_KINDS : [kind] },
        sha256,
        deletedAt: null,
      },
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
    // Spec 0018, AC-3: each photo group has its own limit
    if (isPhotoKind(kind)) {
      const max =
        kind === 'PROOF' ? limits.maxAfterPhotos : limits.maxVehiclePhotos;
      const count = await this.liveCount(db, ticketId, [kind]);
      if (count >= max) throw photoLimitReached(kind, max);
    } else if (DOCUMENT_KINDS.includes(kind)) {
      const count = await this.liveCount(db, ticketId, DOCUMENT_KINDS);
      if (count >= limits.maxDocuments) {
        throw documentLimitReached(limits.maxDocuments);
      }
    }
  }

  private async view(
    row: Attachment,
    now: Date,
    removable: boolean,
  ): Promise<AttachmentView> {
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
      canRemove: removable,
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
