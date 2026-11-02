import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import sharp from 'sharp';
import type { AuthUser } from '../../auth/account-check';
import type { PermissionKey } from '../../auth/permissions/catalog';
import { buildAbility } from '../../auth/permissions/ability.factory';
import { AttachmentsService } from './attachments.service';
import type { FileStore } from './file-store';
import type { PrismaService } from '../../shared/prisma.service';
import type { SettingsService } from '../../settings/settings.service';

// Spec 0017: the upload and remove rules, in the order AC-12b fixes. Prisma and the file store are
// the boundaries and are faked; the image pipeline, the sniffing and CASL run for real.

const TICKET = 'aaaaaaaa-0000-4000-8000-000000000001';
const ISSUE = 'cccccccc-0000-4000-8000-000000000003';
const ME: AuthUser = {
  sub: 'me',
  email: 'me@welinc.com',
  name: 'Mia Mechanic',
  system: 'VRMS',
  roles: [],
};

const MECHANIC_KEYS: PermissionKey[] = ['ticket.view', 'ticket.files.add'];
const CHIEF_KEYS: PermissionKey[] = [
  'ticket.view_all',
  'ticket.files.add',
  'ticket.documents.add',
  'ticket.costs.view',
  'ticket.files.remove_any',
];

const abilityOf = (keys: PermissionKey[]) => buildAbility('me', new Set(keys));

async function png(color = '#3366cc') {
  return sharp({
    create: { width: 40, height: 30, channels: 3, background: color },
  })
    .png()
    .toBuffer();
}

type Row = {
  id: string;
  repairTicketId: string;
  kind: string;
  sha256: string;
  storageKey: string;
  thumbnailKey: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  issueId: string | null;
  uploadedByUserId: string;
  uploadedByName: string;
  createdAt: Date;
  deletedAt: Date | null;
};

function row(over: Partial<Row> = {}): Row {
  return {
    id: 'dddddddd-0000-4000-8000-000000000004',
    repairTicketId: TICKET,
    kind: 'VEHICLE_PHOTO',
    sha256: 'abc',
    storageKey: `tickets/${TICKET}/x/file.jpg`,
    thumbnailKey: `tickets/${TICKET}/x/thumb.webp`,
    fileName: 'front.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 100,
    width: 40,
    height: 30,
    issueId: null,
    uploadedByUserId: 'me',
    uploadedByName: 'Mia Mechanic',
    createdAt: new Date('2026-11-01T01:00:00Z'),
    deletedAt: null,
    ...over,
  };
}

type Setup = {
  status?: string;
  lockedStatus?: string;
  visible?: boolean;
  addCount?: number;
  existing?: Row | null;
  photoCount?: number;
  afterCount?: number;
  documentCount?: number;
  issueOnTicket?: boolean;
  configured?: boolean;
  limits?: {
    maxFileMb?: number;
    photos?: number;
    afterPhotos?: number;
    documents?: number;
  };
  /** Spec 0018: when work started, as first read and as read under the lock. */
  workStartedAt?: Date | null;
  lockedWorkStartedAt?: Date | null;
  failCreateWith?: Error;
  lockedGone?: boolean;
  /** Spec 0018, AC-10: tickets.protect_before_photos (default on). */
  protectBefore?: boolean;
  /** Spec 0018, AC-14: STATUS_CHANGE rows, newest first. */
  statusRows?: { changes: unknown; createdAt: Date }[];
};

function setup(opts: Setup = {}) {
  const puts: string[] = [];
  const deletes: string[] = [];
  const store: FileStore = {
    configured: opts.configured ?? true,
    put: jest.fn((f: { key: string }) => {
      puts.push(f.key);
      return Promise.resolve();
    }),
    delete: jest.fn((k: string) => {
      deletes.push(k);
      return Promise.resolve();
    }),
    readUrl: jest.fn((k: string) => Promise.resolve(`https://blob/${k}`)),

    list: async function* () {},
  };

  const created: Row[] = [];
  const audits: unknown[] = [];
  const tx = {
    $queryRaw: jest.fn(() =>
      Promise.resolve(
        opts.lockedGone
          ? []
          : [
              {
                id: TICKET,
                repair_status: opts.lockedStatus ?? 'IN_PROGRESS',
                work_started_at:
                  opts.lockedWorkStartedAt !== undefined
                    ? opts.lockedWorkStartedAt
                    : (opts.workStartedAt ?? null),
              },
            ],
      ),
    ),
    repairIssue: {
      count: jest.fn(() =>
        Promise.resolve(opts.issueOnTicket === false ? 0 : 1),
      ),
    },
    attachment: {
      findMany: jest.fn(() => Promise.resolve([] as Row[])),
      findFirst: jest.fn(() => Promise.resolve(opts.existing ?? null)),
      count: jest.fn((args: { where: { kind: { in: string[] } } }) =>
        Promise.resolve(
          args.where.kind.in.includes('VEHICLE_PHOTO')
            ? (opts.photoCount ?? 0)
            : args.where.kind.in.includes('PROOF')
              ? (opts.afterCount ?? 0)
              : (opts.documentCount ?? 0),
        ),
      ),
      create: jest.fn((args: { data: Row }) => {
        if (opts.failCreateWith) return Promise.reject(opts.failCreateWith);
        const r = row({ ...args.data });
        created.push(r);
        return Promise.resolve(r);
      }),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      // Spec 0018: the fresh read under the lock, and the move's write
      findUnique: jest.fn(() => Promise.resolve(null as Row | null)),
      update: jest.fn((args: { where: { id: string }; data: Partial<Row> }) =>
        Promise.resolve(row({ id: args.where.id, ...args.data })),
      ),
    },
    auditLog: {
      create: jest.fn((args: unknown) => {
        audits.push(args);
        return Promise.resolve({});
      }),
      // Spec 0018, AC-14: the latest Return to mechanic scan (none by default)
      findMany: jest.fn(() => Promise.resolve(opts.statusRows ?? [])),
    },
  };

  const prisma = {
    ...tx,
    repairTicket: {
      findFirst: jest.fn(() =>
        Promise.resolve(
          opts.visible === false
            ? null
            : {
                id: TICKET,
                repairStatus: opts.status ?? 'IN_PROGRESS',
                workStartedAt: opts.workStartedAt ?? null,
              },
        ),
      ),
      count: jest.fn(() => Promise.resolve(opts.addCount ?? 1)),
    },
    $transaction: jest.fn((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  };

  const values: Record<string, number | boolean> = {
    'tickets.protect_before_photos': opts.protectBefore ?? true,
    'uploads.max_file_mb': opts.limits?.maxFileMb ?? 10,
    'uploads.max_vehicle_photos': opts.limits?.photos ?? 5,
    'uploads.max_after_photos': opts.limits?.afterPhotos ?? 10,
    'uploads.max_documents': opts.limits?.documents ?? 10,
  };
  const settings = {
    get: (k: string) => values[k],
  } as unknown as SettingsService;

  const service = new AttachmentsService(
    prisma as unknown as PrismaService,
    store,
    settings,
  );
  return { service, store, prisma, tx, puts, deletes, created, audits };
}

const dto = (over: Record<string, unknown> = {}) =>
  ({ kind: 'VEHICLE_PHOTO', ...over }) as never;

async function photo(name = 'front.png', color?: string) {
  return { buffer: await png(color), originalname: name };
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const e = error as {
      getStatus?: () => number;
      getResponse?: () => unknown;
    };
    const body = e.getResponse?.() as { code?: string } | undefined;
    return { status: e.getStatus?.(), code: body?.code };
  }
  return null;
}

describe('AttachmentsService.upload', () => {
  describe('happy path (AC-4, AC-6, AC-14, AC-18)', () => {
    it('stores the rebuilt photo and its thumbnail, then inserts the row and the audit row', async () => {
      const s = setup();
      const result = await s.service.upload(
        TICKET,
        await photo(),
        dto(),
        ME,
        abilityOf(MECHANIC_KEYS),
      );

      expect(result.duplicate).toBe(false);
      expect(s.puts).toHaveLength(2);
      expect(s.puts[0]).toMatch(/\/file\.jpg$/);
      expect(s.puts[1]).toMatch(/\/thumb\.webp$/);
      expect(s.created).toHaveLength(1);
      expect(s.audits).toHaveLength(1);
      expect(result.attachment).toMatchObject({
        kind: 'VEHICLE_PHOTO',
        fileName: 'front.jpg',
        mimeType: 'image/jpeg',
        uploadedBy: { id: 'me', name: 'Mia Mechanic' },
        canRemove: true,
      });
      expect(result.attachment.url).toContain('https://blob/');
      expect(result.attachment.thumbnailUrl).toMatch(/thumb\.webp$/);
    });

    it('writes the blobs before the row, so a row never points at nothing (AC-14)', async () => {
      const s = setup();
      const order: string[] = [];
      (s.store.put as jest.Mock).mockImplementation(() => {
        order.push('put');
        return Promise.resolve();
      });
      s.tx.attachment.create.mockImplementation((args: { data: Row }) => {
        order.push('insert');
        return Promise.resolve(row({ ...args.data }));
      });
      await s.service.upload(
        TICKET,
        await photo(),
        dto(),
        ME,
        abilityOf(MECHANIC_KEYS),
      );
      expect(order).toEqual(['put', 'put', 'insert']);
    });

    it('takes the ticket row lock inside the transaction and never writes the ticket (AC-13)', async () => {
      const s = setup();
      await s.service.upload(
        TICKET,
        await photo(),
        dto(),
        ME,
        abilityOf(MECHANIC_KEYS),
      );
      expect(s.tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(s.prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('stores the uploader from the token, with the name cut to 100', async () => {
      const s = setup();
      const long = { ...ME, name: 'N'.repeat(150) };
      await s.service.upload(
        TICKET,
        await photo(),
        dto(),
        long,
        abilityOf(MECHANIC_KEYS),
      );
      expect(s.tx.attachment.create.mock.calls[0][0].data).toMatchObject({
        uploadedByUserId: 'me',
        uploadedByName: 'N'.repeat(100),
      });
    });

    it('ignores an issue tag on a photo (spec 0018)', async () => {
      const s = setup({ issueOnTicket: false });
      await s.service.upload(
        TICKET,
        await photo(),
        dto({ kind: 'PHOTO', issueId: ISSUE }),
        ME,
        abilityOf(MECHANIC_KEYS),
      );
      expect(s.created[0].issueId).toBeNull();
    });
  });

  describe('derived kind (spec 0018, AC-1)', () => {
    const STARTED = new Date('2026-11-01T02:00:00Z');

    it('files a photo as Before while work has not started', async () => {
      const s = setup();
      const result = await s.service.upload(
        TICKET,
        await photo(),
        dto({ kind: 'PHOTO' }),
        ME,
        abilityOf(MECHANIC_KEYS),
      );
      expect(result.attachment.kind).toBe('VEHICLE_PHOTO');
    });

    it('files a photo as After once work has started', async () => {
      const s = setup({ workStartedAt: STARTED });
      const result = await s.service.upload(
        TICKET,
        await photo(),
        dto({ kind: 'PHOTO' }),
        ME,
        abilityOf(MECHANIC_KEYS),
      );
      expect(result.attachment.kind).toBe('PROOF');
    });

    it('never lets the client choose: an old VEHICLE_PHOTO after start lands in After', async () => {
      const s = setup({ workStartedAt: STARTED });
      const result = await s.service.upload(
        TICKET,
        await photo(),
        dto({ kind: 'VEHICLE_PHOTO' }),
        ME,
        abilityOf(MECHANIC_KEYS),
      );
      expect(result.attachment.kind).toBe('PROOF');
    });

    it('reads the kind again under the lock when work started in between', async () => {
      const s = setup({ workStartedAt: null, lockedWorkStartedAt: STARTED });
      const result = await s.service.upload(
        TICKET,
        await photo(),
        dto({ kind: 'PHOTO' }),
        ME,
        abilityOf(MECHANIC_KEYS),
      );
      expect(result.attachment.kind).toBe('PROOF');
    });

    it('checks the After cap again under the lock for the new kind (AC-3)', async () => {
      const s = setup({
        workStartedAt: null,
        lockedWorkStartedAt: STARTED,
        afterCount: 10,
      });
      expect(
        await codeOf(
          s.service.upload(
            TICKET,
            await photo(),
            dto({ kind: 'PHOTO' }),
            ME,
            abilityOf(MECHANIC_KEYS),
          ),
        ),
      ).toEqual({ status: 409, code: 'PHOTO_LIMIT_REACHED' });
      expect(s.created).toHaveLength(0);
      expect(s.deletes).toHaveLength(2);
    });

    it('refuses a PDF sent as a photo with 415, before or after start (AC-2)', async () => {
      for (const workStartedAt of [null, STARTED]) {
        const s = setup({ workStartedAt });
        expect(
          await codeOf(
            s.service.upload(
              TICKET,
              { buffer: Buffer.from('%PDF-1.4\n%fake'), originalname: 'a.pdf' },
              dto({ kind: 'PROOF' }),
              ME,
              abilityOf(MECHANIC_KEYS),
            ),
          ),
        ).toEqual({ status: 415, code: 'FILE_TYPE_NOT_ALLOWED' });
      }
    });
  });

  describe('error order (AC-12b)', () => {
    it('answers 404 for a ticket the caller cannot see, before anything else', async () => {
      const s = setup({ visible: false });
      await expect(
        s.service.upload(
          TICKET,
          await photo(),
          dto(),
          ME,
          abilityOf(MECHANIC_KEYS),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(s.puts).toHaveLength(0);
    });

    it('answers 404 for an id that is not a uuid, without asking the database', async () => {
      const s = setup();
      await expect(
        s.service.upload(
          'not-a-uuid',
          await photo(),
          dto(),
          ME,
          abilityOf(MECHANIC_KEYS),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(s.prisma.repairTicket.findFirst).not.toHaveBeenCalled();
    });

    it('answers 404 when the caller has no read right at all', async () => {
      const s = setup();
      await expect(
        s.service.upload(TICKET, await photo(), dto(), ME, abilityOf([])),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers 403 FORBIDDEN_KIND before 409 TICKET_FINISHED', async () => {
      const s = setup({ status: 'CLOSED' });
      expect(
        await codeOf(
          s.service.upload(
            TICKET,
            await photo(),
            dto({ kind: 'RECEIPT' }),
            ME,
            abilityOf(MECHANIC_KEYS),
          ),
        ),
      ).toEqual({ status: 403, code: 'FORBIDDEN_KIND' });
    });

    it('answers 409 TICKET_FINISHED on a closed ticket, before the size check', async () => {
      const s = setup({ status: 'CLOSED' });
      expect(
        await codeOf(
          s.service.upload(
            TICKET,
            { buffer: Buffer.alloc(11 * 1024 * 1024), originalname: 'a.png' },
            dto(),
            ME,
            abilityOf(MECHANIC_KEYS),
          ),
        ),
      ).toEqual({ status: 409, code: 'TICKET_FINISHED' });
    });

    it('answers 413 FILE_TOO_LARGE over the setting, before the type check', async () => {
      const s = setup({ limits: { maxFileMb: 1 } });
      expect(
        await codeOf(
          s.service.upload(
            TICKET,
            { buffer: Buffer.alloc(2 * 1024 * 1024), originalname: 'a.png' },
            dto(),
            ME,
            abilityOf(MECHANIC_KEYS),
          ),
        ),
      ).toEqual({ status: 413, code: 'FILE_TOO_LARGE' });
    });

    it('reads the size setting on every request', async () => {
      const s = setup({ limits: { maxFileMb: 1 } });
      const file = { buffer: await png(), originalname: 'a.png' };
      await expect(
        s.service.upload(TICKET, file, dto(), ME, abilityOf(MECHANIC_KEYS)),
      ).resolves.toMatchObject({ duplicate: false });
    });

    it('answers 400 NO_FILE when there is no file or it is empty', async () => {
      const s = setup();
      const ability = abilityOf(MECHANIC_KEYS);
      expect(
        await codeOf(s.service.upload(TICKET, undefined, dto(), ME, ability)),
      ).toEqual({ status: 400, code: 'NO_FILE' });
      expect(
        await codeOf(
          s.service.upload(
            TICKET,
            { buffer: Buffer.alloc(0), originalname: 'a.png' },
            dto(),
            ME,
            ability,
          ),
        ),
      ).toEqual({ status: 400, code: 'NO_FILE' });
    });
  });

  describe('type rules (AC-4)', () => {
    it('answers 415 for bytes that are not a known type, whatever the name says', async () => {
      const s = setup();
      const result = codeOf(
        s.service.upload(
          TICKET,
          {
            buffer: Buffer.from('MZ not a photo at all'),
            originalname: 'virus.png',
          },
          dto(),
          ME,
          abilityOf(MECHANIC_KEYS),
        ),
      );
      expect(await result).toEqual({
        status: 415,
        code: 'FILE_TYPE_NOT_ALLOWED',
      });
      expect(s.puts).toHaveLength(0);
    });

    it('names what the file really is when the kind does not take it', async () => {
      const s = setup();
      await expect(
        s.service.upload(
          TICKET,
          { buffer: Buffer.from('%PDF-1.4\n%fake'), originalname: 'a.png' },
          dto(),
          ME,
          abilityOf(MECHANIC_KEYS),
        ),
      ).rejects.toMatchObject({
        response: {
          message: 'Photo accepts JPEG, PNG or HEIC photos. This file is PDF.',
        },
      });
    });

    it('answers 422 FILE_UNREADABLE for a photo that is cut off', async () => {
      const s = setup();
      const whole = await png();
      expect(
        await codeOf(
          s.service.upload(
            TICKET,
            { buffer: whole.subarray(0, 40), originalname: 'cut.png' },
            dto(),
            ME,
            abilityOf(MECHANIC_KEYS),
          ),
        ),
      ).toEqual({ status: 422, code: 'FILE_UNREADABLE' });
      expect(s.puts).toHaveLength(0);
    });
  });

  describe('issue tag (AC-11)', () => {
    it('answers 400 ISSUE_NOT_ON_TICKET when a document names an issue', async () => {
      const s = setup();
      expect(
        await codeOf(
          s.service.upload(
            TICKET,
            await photo(),
            dto({ kind: 'RECEIPT', issueId: ISSUE }),
            ME,
            abilityOf(CHIEF_KEYS),
          ),
        ),
      ).toEqual({ status: 400, code: 'ISSUE_NOT_ON_TICKET' });
    });
  });

  describe('rights (AC-15, AC-16)', () => {
    it('refuses a receipt to someone with the documents key but no ticket.costs.view', async () => {
      const s = setup();
      const keys: PermissionKey[] = [
        'ticket.view_all',
        'ticket.files.add',
        'ticket.documents.add',
      ];
      expect(
        await codeOf(
          s.service.upload(
            TICKET,
            await photo(),
            dto({ kind: 'RECEIPT' }),
            ME,
            abilityOf(keys),
          ),
        ),
      ).toEqual({ status: 403, code: 'FORBIDDEN_KIND' });
    });

    it('refuses a photo when the add count for the ticket is zero (not assigned)', async () => {
      const s = setup({ addCount: 0 });
      expect(
        await codeOf(
          s.service.upload(
            TICKET,
            await photo(),
            dto(),
            ME,
            abilityOf(MECHANIC_KEYS),
          ),
        ),
      ).toEqual({ status: 403, code: 'FORBIDDEN_KIND' });
    });

    it('refuses a photo without the files key', async () => {
      const s = setup();
      expect(
        await codeOf(
          s.service.upload(
            TICKET,
            await photo(),
            dto(),
            ME,
            abilityOf(['ticket.view']),
          ),
        ),
      ).toEqual({ status: 403, code: 'FORBIDDEN_KIND' });
    });

    it('lets a Chief add a receipt', async () => {
      const s = setup();
      const result = await s.service.upload(
        TICKET,
        await photo(),
        dto({ kind: 'RECEIPT' }),
        ME,
        abilityOf(CHIEF_KEYS),
      );
      expect(result.attachment.kind).toBe('RECEIPT');
    });
  });

  describe('caps (AC-8, AC-9)', () => {
    it('answers 409 PHOTO_LIMIT_REACHED at the Before cap, naming the group', async () => {
      const s = setup({ photoCount: 5 });
      await expect(
        s.service.upload(
          TICKET,
          await photo(),
          dto(),
          ME,
          abilityOf(MECHANIC_KEYS),
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          code: 'PHOTO_LIMIT_REACHED',
          message: expect.stringContaining('5 before photos') as unknown,
        },
      });
      expect(s.puts).toHaveLength(0);
    });

    it('counts After photos against their own limit (spec 0018, AC-3)', async () => {
      const started = new Date('2026-11-01T02:00:00Z');
      const full = setup({
        workStartedAt: started,
        photoCount: 5,
        afterCount: 3,
        limits: { afterPhotos: 3 },
      });
      await expect(
        full.service.upload(
          TICKET,
          await photo(),
          dto({ kind: 'PHOTO' }),
          ME,
          abilityOf(MECHANIC_KEYS),
        ),
      ).rejects.toMatchObject({
        response: {
          code: 'PHOTO_LIMIT_REACHED',
          message: expect.stringContaining('3 after photos') as unknown,
        },
      });
      // A full Before group does not block an After photo
      const room = setup({ workStartedAt: started, photoCount: 5 });
      await expect(
        room.service.upload(
          TICKET,
          await photo(),
          dto({ kind: 'PHOTO' }),
          ME,
          abilityOf(MECHANIC_KEYS),
        ),
      ).resolves.toMatchObject({ attachment: { kind: 'PROOF' } });
    });

    it('accepts the last free slot', async () => {
      const s = setup({ photoCount: 4 });
      await expect(
        s.service.upload(
          TICKET,
          await photo(),
          dto(),
          ME,
          abilityOf(MECHANIC_KEYS),
        ),
      ).resolves.toMatchObject({ duplicate: false });
    });

    it('answers 409 DOCUMENT_LIMIT_REACHED at the document cap', async () => {
      const s = setup({ documentCount: 10 });
      expect(
        await codeOf(
          s.service.upload(
            TICKET,
            await photo(),
            dto({ kind: 'RECEIPT' }),
            ME,
            abilityOf(CHIEF_KEYS),
          ),
        ),
      ).toEqual({ status: 409, code: 'DOCUMENT_LIMIT_REACHED' });
    });

    it('does not count vehicle photos against the document cap', async () => {
      const s = setup({ documentCount: 10 });
      await expect(
        s.service.upload(
          TICKET,
          await photo(),
          dto(),
          ME,
          abilityOf(CHIEF_KEYS),
        ),
      ).resolves.toMatchObject({ duplicate: false });
    });
  });

  describe('duplicates (AC-8)', () => {
    it('looks across Before and After as one pool (spec 0018, AC-21)', async () => {
      const s = setup({
        workStartedAt: new Date('2026-11-01T02:00:00Z'),
        existing: row({ kind: 'VEHICLE_PHOTO' }),
      });
      const result = await s.service.upload(
        TICKET,
        await photo(),
        dto({ kind: 'PHOTO' }),
        ME,
        abilityOf(MECHANIC_KEYS),
      );
      expect(result).toMatchObject({
        duplicate: true,
        attachment: { kind: 'VEHICLE_PHOTO' },
      });
      const [{ where }] = s.prisma.attachment.findFirst.mock
        .calls[0] as unknown as [{ where: { kind: { in: string[] } } }];
      expect(where.kind.in).toEqual(['VEHICLE_PHOTO', 'PROOF']);
    });

    it('keeps documents in a pool of their own kind', async () => {
      const s = setup();
      await s.service.upload(
        TICKET,
        await photo(),
        dto({ kind: 'RECEIPT' }),
        ME,
        abilityOf(CHIEF_KEYS),
      );
      const [{ where }] = s.prisma.attachment.findFirst.mock
        .calls[0] as unknown as [{ where: { kind: { in: string[] } } }];
      expect(where.kind.in).toEqual(['RECEIPT']);
    });

    it('answers the existing file with duplicate true and stores nothing', async () => {
      const s = setup({ existing: row({ uploadedByUserId: 'someone-else' }) });
      const result = await s.service.upload(
        TICKET,
        await photo(),
        dto(),
        ME,
        abilityOf(MECHANIC_KEYS),
      );
      expect(result.duplicate).toBe(true);
      expect(s.puts).toHaveLength(0);
      expect(s.created).toHaveLength(0);
      expect(s.audits).toHaveLength(0);
    });

    it('is a duplicate even when the ticket is at its cap', async () => {
      const s = setup({ existing: row(), photoCount: 5 });
      const result = await s.service.upload(
        TICKET,
        await photo(),
        dto(),
        ME,
        abilityOf(MECHANIC_KEYS),
      );
      expect(result.duplicate).toBe(true);
    });

    it('cleans up and answers the winner when the unique index catches a race', async () => {
      const unique = new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      });
      const s = setup({ failCreateWith: unique });
      // First look (before the transaction) and the in-transaction look find nothing, the look
      // after the failed insert finds the winning row
      s.tx.attachment.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(row({ uploadedByUserId: 'someone-else' }));
      const result = await s.service.upload(
        TICKET,
        await photo(),
        dto(),
        ME,
        abilityOf(MECHANIC_KEYS),
      );
      expect(result.duplicate).toBe(true);
      expect(s.deletes.sort()).toEqual([...s.puts].sort());
    });
  });

  describe('failure cleanup (AC-14)', () => {
    it('deletes the blobs it wrote when the insert fails, and rethrows', async () => {
      const s = setup({ failCreateWith: new Error('db down') });
      await expect(
        s.service.upload(
          TICKET,
          await photo(),
          dto(),
          ME,
          abilityOf(MECHANIC_KEYS),
        ),
      ).rejects.toThrow('db down');
      expect(s.puts).toHaveLength(2);
      expect(s.deletes.sort()).toEqual([...s.puts].sort());
    });

    it('deletes the blobs when the ticket finished while the file was processing (AC-10)', async () => {
      const s = setup({ lockedStatus: 'CLOSED' });
      expect(
        await codeOf(
          s.service.upload(
            TICKET,
            await photo(),
            dto(),
            ME,
            abilityOf(MECHANIC_KEYS),
          ),
        ),
      ).toEqual({ status: 409, code: 'TICKET_FINISHED' });
      expect(s.deletes.sort()).toEqual([...s.puts].sort());
      expect(s.created).toHaveLength(0);
    });

    it('still reports the real error when a cleanup delete fails too', async () => {
      const s = setup({ failCreateWith: new Error('db down') });
      (s.store.delete as jest.Mock).mockRejectedValue(new Error('blob down'));
      await expect(
        s.service.upload(
          TICKET,
          await photo(),
          dto(),
          ME,
          abilityOf(MECHANIC_KEYS),
        ),
      ).rejects.toThrow('db down');
    });

    it('stores nothing when a blob write fails', async () => {
      const s = setup();
      (s.store.put as jest.Mock).mockRejectedValue(new Error('blob down'));
      await expect(
        s.service.upload(
          TICKET,
          await photo(),
          dto(),
          ME,
          abilityOf(MECHANIC_KEYS),
        ),
      ).rejects.toThrow('blob down');
      expect(s.created).toHaveLength(0);
    });
  });

  describe('storage not configured (AC-3)', () => {
    it('answers 503 STORAGE_UNAVAILABLE before any lookup', async () => {
      const s = setup({ configured: false });
      expect(
        await codeOf(
          s.service.upload(
            TICKET,
            await photo(),
            dto(),
            ME,
            abilityOf(MECHANIC_KEYS),
          ),
        ),
      ).toEqual({ status: 503, code: 'STORAGE_UNAVAILABLE' });
      expect(s.prisma.repairTicket.findFirst).not.toHaveBeenCalled();
    });
  });
});

describe('AttachmentsService.remove (AC-17, AC-18)', () => {
  const ATT = 'dddddddd-0000-4000-8000-000000000004';

  function removeSetup(attachment: Row | null, opts: Setup = {}) {
    const s = setup(opts);
    s.prisma.attachment.findFirst.mockResolvedValue(attachment);
    s.tx.attachment.findUnique.mockResolvedValue(attachment);
    return s;
  }

  it('soft deletes your own photo and writes one audit row', async () => {
    const s = removeSetup(row());
    await s.service.remove(TICKET, ATT, ME, abilityOf(MECHANIC_KEYS));
    const [call] = s.tx.attachment.updateMany.mock.calls[0] as unknown as [
      { where: unknown; data: unknown },
    ];
    expect(call).toMatchObject({
      where: { id: row().id, deletedAt: null },
      data: { deletedByUserId: 'me', deletedByName: 'Mia Mechanic' },
    });
    expect(s.audits).toHaveLength(1);
    expect(s.deletes).toHaveLength(0);
  });

  it('answers 404 when the attachment is not on the ticket', async () => {
    const s = removeSetup(null);
    await expect(
      s.service.remove(TICKET, ATT, ME, abilityOf(MECHANIC_KEYS)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('only looks among kinds the caller may see, so a receipt is 404 without costs.view', async () => {
    const s = removeSetup(null);
    await s.service
      .remove(TICKET, ATT, ME, abilityOf(MECHANIC_KEYS))
      .catch(() => undefined);
    const [{ where }] = s.prisma.attachment.findFirst.mock
      .calls[0] as unknown as [{ where: { kind: { in: string[] } } }];
    expect(where.kind.in).toEqual(['VEHICLE_PHOTO', 'PROOF']);
  });

  it('answers 204 again for an already removed file, with no second audit row', async () => {
    const s = removeSetup(row({ deletedAt: new Date() }));
    await expect(
      s.service.remove(TICKET, ATT, ME, abilityOf(MECHANIC_KEYS)),
    ).resolves.toBeUndefined();
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
    expect(s.audits).toHaveLength(0);
  });

  it('answers 403 NOT_YOUR_FILE for someone else’s file without remove_any', async () => {
    const s = removeSetup(row({ uploadedByUserId: 'chief' }));
    expect(
      await codeOf(s.service.remove(TICKET, ATT, ME, abilityOf(MECHANIC_KEYS))),
    ).toEqual({ status: 403, code: 'NOT_YOUR_FILE' });
  });

  it('lets remove_any take someone else’s file', async () => {
    const s = removeSetup(row({ uploadedByUserId: 'mechanic-2' }));
    await s.service.remove(TICKET, ATT, ME, abilityOf(CHIEF_KEYS));
    expect(s.audits).toHaveLength(1);
  });

  it('answers 403 once you lost the add right for your own file’s kind', async () => {
    const s = removeSetup(row(), { addCount: 0 });
    expect(
      await codeOf(s.service.remove(TICKET, ATT, ME, abilityOf(MECHANIC_KEYS))),
    ).toEqual({ status: 403, code: 'NOT_YOUR_FILE' });
  });

  it('answers 409 TICKET_FINISHED on a closed ticket, even for remove_any', async () => {
    const s = removeSetup(row(), { status: 'CLOSED' });
    expect(
      await codeOf(s.service.remove(TICKET, ATT, ME, abilityOf(CHIEF_KEYS))),
    ).toEqual({ status: 409, code: 'TICKET_FINISHED' });
  });

  it('answers 409 when the ticket finished after the first check (row lock)', async () => {
    const s = removeSetup(row(), { lockedStatus: 'CLOSED' });
    expect(
      await codeOf(s.service.remove(TICKET, ATT, ME, abilityOf(CHIEF_KEYS))),
    ).toEqual({ status: 409, code: 'TICKET_FINISHED' });
    expect(s.audits).toHaveLength(0);
  });

  it('writes no audit row when a racing remove already changed the row', async () => {
    const s = removeSetup(row());
    s.tx.attachment.updateMany.mockResolvedValue({ count: 0 });
    await s.service.remove(TICKET, ATT, ME, abilityOf(MECHANIC_KEYS));
    expect(s.audits).toHaveLength(0);
  });

  it('answers 404 for a ticket the caller cannot see', async () => {
    const s = removeSetup(row(), { visible: false });
    await expect(
      s.service.remove(TICKET, ATT, ME, abilityOf(MECHANIC_KEYS)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers 503 when storage is not configured', async () => {
    const s = removeSetup(row(), { configured: false });
    expect(
      await codeOf(s.service.remove(TICKET, ATT, ME, abilityOf(MECHANIC_KEYS))),
    ).toEqual({ status: 503, code: 'STORAGE_UNAVAILABLE' });
  });

  describe('Before protection (spec 0018, AC-10)', () => {
    const started = { workStartedAt: new Date('2026-11-01T02:00:00Z') };

    it('answers 403 BEFORE_PHOTO_PROTECTED for your own Before photo once work started', async () => {
      const s = removeSetup(row(), started);
      expect(
        await codeOf(
          s.service.remove(TICKET, ATT, ME, abilityOf(MECHANIC_KEYS)),
        ),
      ).toEqual({ status: 403, code: 'BEFORE_PHOTO_PROTECTED' });
      expect(s.audits).toHaveLength(0);
    });

    it('answers NOT_YOUR_FILE first for someone else’s protected Before photo', async () => {
      const s = removeSetup(row({ uploadedByUserId: 'chief' }), started);
      expect(
        await codeOf(
          s.service.remove(TICKET, ATT, ME, abilityOf(MECHANIC_KEYS)),
        ),
      ).toEqual({ status: 403, code: 'NOT_YOUR_FILE' });
    });

    it('lets remove_any remove it, and the uploader with the switch off or before work starts', async () => {
      const chief = removeSetup(row(), started);
      await chief.service.remove(TICKET, ATT, ME, abilityOf(CHIEF_KEYS));
      expect(chief.audits).toHaveLength(1);

      const off = removeSetup(row(), { ...started, protectBefore: false });
      await off.service.remove(TICKET, ATT, ME, abilityOf(MECHANIC_KEYS));
      expect(off.audits).toHaveLength(1);

      const early = removeSetup(row());
      await early.service.remove(TICKET, ATT, ME, abilityOf(MECHANIC_KEYS));
      expect(early.audits).toHaveLength(1);
    });

    it('checks again under the lock: work started after the first read', async () => {
      const s = removeSetup(row(), {
        lockedWorkStartedAt: started.workStartedAt,
      });
      expect(
        await codeOf(
          s.service.remove(TICKET, ATT, ME, abilityOf(MECHANIC_KEYS)),
        ),
      ).toEqual({ status: 403, code: 'BEFORE_PHOTO_PROTECTED' });
      expect(s.tx.attachment.updateMany).not.toHaveBeenCalled();
    });

    it('never protects an After photo', async () => {
      const s = removeSetup(row({ kind: 'PROOF' }), started);
      await s.service.remove(TICKET, ATT, ME, abilityOf(MECHANIC_KEYS));
      expect(s.audits).toHaveLength(1);
    });
  });
});

describe('AttachmentsService.move (spec 0018, AC-9 to AC-11, AC-21)', () => {
  const ATT = 'dddddddd-0000-4000-8000-000000000004';
  const started = { workStartedAt: new Date('2026-11-01T02:00:00Z') };

  function moveSetup(attachment: Row | null, opts: Setup = {}) {
    const s = setup(opts);
    // The visibility read, then the duplicate check (none unless a test says so)
    s.prisma.attachment.findFirst
      .mockResolvedValueOnce(attachment)
      .mockResolvedValue(null);
    s.tx.attachment.findUnique.mockResolvedValue(attachment);
    return s;
  }

  it('moves your own After photo to Before with one ATTACHMENT_MOVED row', async () => {
    const s = moveSetup(row({ kind: 'PROOF' }), started);
    const view = await s.service.move(
      TICKET,
      ATT,
      'VEHICLE_PHOTO',
      ME,
      abilityOf(MECHANIC_KEYS),
    );
    expect(view.kind).toBe('VEHICLE_PHOTO');
    expect(s.tx.attachment.update).toHaveBeenCalledWith({
      where: { id: ATT },
      data: { kind: 'VEHICLE_PHOTO' },
    });
    expect(s.audits).toEqual([
      {
        data: expect.objectContaining({
          action: 'ATTACHMENT_MOVED',
          changes: expect.arrayContaining([
            { field: 'kind', before: 'PROOF', after: 'VEHICLE_PHOTO' },
            {
              field: 'attachment',
              before: 'After photo: front.jpg',
              after: 'Before photo: front.jpg',
            },
          ]) as unknown,
        }) as unknown,
      },
    ]);
    // Now a protected Before photo: the mechanic can no longer move or remove it
    expect(view).toMatchObject({ canMove: false, canRemove: false });
  });

  it('answers 200 with no audit row when the photo is already in that group', async () => {
    const s = moveSetup(row({ kind: 'PROOF' }));
    const view = await s.service.move(
      TICKET,
      ATT,
      'PROOF',
      ME,
      abilityOf(MECHANIC_KEYS),
    );
    expect(view.kind).toBe('PROOF');
    expect(s.prisma.$transaction).not.toHaveBeenCalled();
    expect(s.audits).toHaveLength(0);
  });

  it('answers 400 NOT_A_PHOTO for a document or a non photo target, after 404', async () => {
    const doc = moveSetup(row({ kind: 'RECEIPT' }));
    expect(
      await codeOf(
        doc.service.move(TICKET, ATT, 'PROOF', ME, abilityOf(CHIEF_KEYS)),
      ),
    ).toEqual({ status: 400, code: 'NOT_A_PHOTO' });
    const target = moveSetup(row());
    expect(
      await codeOf(
        target.service.move(TICKET, ATT, 'RECEIPT', ME, abilityOf(CHIEF_KEYS)),
      ),
    ).toEqual({ status: 400, code: 'NOT_A_PHOTO' });
    const gone = moveSetup(null);
    await expect(
      gone.service.move(TICKET, ATT, 'NOPE', ME, abilityOf(CHIEF_KEYS)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers 403 NOT_YOUR_FILE with the move wording for someone else’s photo', async () => {
    const s = moveSetup(row({ kind: 'PROOF', uploadedByUserId: 'chief' }));
    await expect(
      s.service.move(
        TICKET,
        ATT,
        'VEHICLE_PHOTO',
        ME,
        abilityOf(MECHANIC_KEYS),
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'NOT_YOUR_FILE',
        message: 'You can only move photos you added yourself.',
      },
    });
  });

  it('protects a Before photo from moving to After once work started, except for remove_any', async () => {
    const s = moveSetup(row(), started);
    expect(
      await codeOf(
        s.service.move(TICKET, ATT, 'PROOF', ME, abilityOf(MECHANIC_KEYS)),
      ),
    ).toEqual({ status: 403, code: 'BEFORE_PHOTO_PROTECTED' });

    const chief = moveSetup(row(), started);
    const view = await chief.service.move(
      TICKET,
      ATT,
      'PROOF',
      ME,
      abilityOf(CHIEF_KEYS),
    );
    expect(view.kind).toBe('PROOF');
  });

  it('answers 409 TICKET_FINISHED after the 403s, and under the lock', async () => {
    const closed = moveSetup(row({ kind: 'PROOF' }), { status: 'CLOSED' });
    expect(
      await codeOf(
        closed.service.move(
          TICKET,
          ATT,
          'VEHICLE_PHOTO',
          ME,
          abilityOf(CHIEF_KEYS),
        ),
      ),
    ).toEqual({ status: 409, code: 'TICKET_FINISHED' });
    const raced = moveSetup(row({ kind: 'PROOF' }), {
      lockedStatus: 'CLOSED',
    });
    expect(
      await codeOf(
        raced.service.move(
          TICKET,
          ATT,
          'VEHICLE_PHOTO',
          ME,
          abilityOf(CHIEF_KEYS),
        ),
      ),
    ).toEqual({ status: 409, code: 'TICKET_FINISHED' });
    expect(raced.audits).toHaveLength(0);
  });

  it('answers 409 PHOTO_LIMIT_REACHED when the target group is full (AC-3)', async () => {
    const s = moveSetup(row({ kind: 'PROOF' }), {
      photoCount: 5,
      limits: { photos: 5 },
    });
    expect(
      await codeOf(
        s.service.move(
          TICKET,
          ATT,
          'VEHICLE_PHOTO',
          ME,
          abilityOf(MECHANIC_KEYS),
        ),
      ),
    ).toEqual({ status: 409, code: 'PHOTO_LIMIT_REACHED' });
    expect(s.tx.attachment.update).not.toHaveBeenCalled();
  });

  it('answers 409 DUPLICATE_PHOTO for a live copy in the target group, and for an index race', async () => {
    const s = moveSetup(row({ kind: 'PROOF' }));
    s.tx.attachment.findFirst.mockResolvedValue(row({ id: 'other' }));
    expect(
      await codeOf(
        s.service.move(
          TICKET,
          ATT,
          'VEHICLE_PHOTO',
          ME,
          abilityOf(MECHANIC_KEYS),
        ),
      ),
    ).toEqual({ status: 409, code: 'DUPLICATE_PHOTO' });

    const raced = moveSetup(row({ kind: 'PROOF' }));
    raced.tx.attachment.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    expect(
      await codeOf(
        raced.service.move(
          TICKET,
          ATT,
          'VEHICLE_PHOTO',
          ME,
          abilityOf(MECHANIC_KEYS),
        ),
      ),
    ).toEqual({ status: 409, code: 'DUPLICATE_PHOTO' });
  });
});

describe('AttachmentsService.list (AC-16, Value sourcing)', () => {
  function listSetup(rows: Row[], opts: Setup = {}) {
    const s = setup(opts);
    s.prisma.attachment.findMany.mockResolvedValue(rows);
    return s;
  }

  it('asks only for live rows of the kinds the caller may see', async () => {
    const s = listSetup([]);
    await s.service.list(TICKET, ME, abilityOf(MECHANIC_KEYS));
    const [{ where }] = s.prisma.attachment.findMany.mock
      .calls[0] as unknown as [{ where: { kind: { in: string[] } } }];
    expect(where).toMatchObject({
      repairTicketId: TICKET,
      deletedAt: null,
      purgedAt: null,
    });
    expect(where.kind.in).toEqual(['VEHICLE_PHOTO', 'PROOF']);
  });

  it('shows a Chief receipts and other documents too', async () => {
    const s = listSetup([]);
    const result = await s.service.list(TICKET, ME, abilityOf(CHIEF_KEYS));
    expect(result.kinds.map((k) => k.kind)).toEqual([
      'PHOTO',
      'RECEIPT',
      'OTHER_DOCUMENT',
    ]);
  });

  it('lists the photo upload as one PHOTO kind that takes images only (spec 0018)', async () => {
    const s = listSetup([]);
    const result = await s.service.list(TICKET, ME, abilityOf(MECHANIC_KEYS));
    expect(result.kinds).toEqual([
      {
        kind: 'PHOTO',
        label: 'Photo',
        accepts: ['image/jpeg', 'image/png', 'image/heic'],
        acceptsLabel: 'JPEG, PNG or HEIC photos',
      },
    ]);
  });

  it('reports the limits from the settings and counts documents only with costs.view', async () => {
    const s = listSetup([], {
      limits: { maxFileMb: 7, photos: 4, afterPhotos: 8, documents: 9 },
      photoCount: 3,
      afterCount: 6,
      documentCount: 2,
    });
    const mech = await s.service.list(TICKET, ME, abilityOf(MECHANIC_KEYS));
    expect(mech.limits).toEqual({
      maxFileMb: 7,
      maxVehiclePhotos: 4,
      maxAfterPhotos: 8,
      maxDocuments: 9,
      vehiclePhotoCount: 3,
      afterPhotoCount: 6,
      documentCount: 0,
    });
    const chief = await s.service.list(TICKET, ME, abilityOf(CHIEF_KEYS));
    expect(chief.limits.documentCount).toBe(2);
  });

  it('turns every can flag and canRemove off on a finished ticket', async () => {
    const s = listSetup([row()], { status: 'CLOSED' });
    const result = await s.service.list(TICKET, ME, abilityOf(CHIEF_KEYS));
    expect(result.can).toEqual({ addFiles: false, addDocuments: false });
    expect(result.items[0].canRemove).toBe(false);
  });

  it('turns can.addDocuments off without ticket.costs.view even with the key', async () => {
    const s = listSetup([]);
    const keys: PermissionKey[] = [
      'ticket.view_all',
      'ticket.files.add',
      'ticket.documents.add',
    ];
    const result = await s.service.list(TICKET, ME, abilityOf(keys));
    expect(result.can).toEqual({ addFiles: true, addDocuments: false });
  });

  it('sets canRemove per row: own file yes, someone else’s no, remove_any yes', async () => {
    const mine = row({ id: 'm' });
    const theirs = row({ id: 't', uploadedByUserId: 'chief' });
    const s = listSetup([mine, theirs]);
    const mech = await s.service.list(TICKET, ME, abilityOf(MECHANIC_KEYS));
    expect(mech.items.map((i) => i.canRemove)).toEqual([true, false]);
    const chief = await s.service.list(TICKET, ME, abilityOf(CHIEF_KEYS));
    expect(chief.items.map((i) => i.canRemove)).toEqual([true, true]);
  });

  it('gives a thumbnail link only to files that have a thumbnail', async () => {
    const s = listSetup([
      row({ id: 'p' }),
      row({
        id: 'd',
        kind: 'OTHER_DOCUMENT',
        thumbnailKey: null,
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
      }),
    ]);
    const result = await s.service.list(TICKET, ME, abilityOf(CHIEF_KEYS));
    expect(result.items[0].thumbnailUrl).not.toBeNull();
    expect(result.items[1].thumbnailUrl).toBeNull();
  });

  it('answers 404 for a ticket the caller cannot see', async () => {
    const s = listSetup([], { visible: false });
    await expect(
      s.service.list(TICKET, ME, abilityOf(MECHANIC_KEYS)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers 503 when storage is not configured', async () => {
    const s = listSetup([], { configured: false });
    expect(
      await codeOf(s.service.list(TICKET, ME, abilityOf(MECHANIC_KEYS))),
    ).toEqual({ status: 503, code: 'STORAGE_UNAVAILABLE' });
  });
});
