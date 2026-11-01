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
  documentCount?: number;
  issueOnTicket?: boolean;
  configured?: boolean;
  limits?: { maxFileMb?: number; photos?: number; documents?: number };
  failCreateWith?: Error;
  lockedGone?: boolean;
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
          : [{ id: TICKET, repair_status: opts.lockedStatus ?? 'IN_PROGRESS' }],
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
    },
    auditLog: {
      create: jest.fn((args: unknown) => {
        audits.push(args);
        return Promise.resolve({});
      }),
    },
  };

  const prisma = {
    ...tx,
    repairTicket: {
      findFirst: jest.fn(() =>
        Promise.resolve(
          opts.visible === false
            ? null
            : { id: TICKET, repairStatus: opts.status ?? 'IN_PROGRESS' },
        ),
      ),
      count: jest.fn(() => Promise.resolve(opts.addCount ?? 1)),
    },
    $transaction: jest.fn((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  };

  const values: Record<string, number> = {
    'uploads.max_file_mb': opts.limits?.maxFileMb ?? 10,
    'uploads.max_vehicle_photos': opts.limits?.photos ?? 5,
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

    it('tags a photo to an issue that belongs to the ticket (AC-11)', async () => {
      const s = setup();
      await s.service.upload(
        TICKET,
        await photo(),
        dto({ issueId: ISSUE }),
        ME,
        abilityOf(MECHANIC_KEYS),
      );
      expect(s.created[0].issueId).toBe(ISSUE);
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
          message:
            'Vehicle photo accepts JPEG, PNG or HEIC photos. This file is PDF.',
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
    it('answers 400 ISSUE_NOT_ON_TICKET for an issue on another ticket', async () => {
      const s = setup({ issueOnTicket: false });
      expect(
        await codeOf(
          s.service.upload(
            TICKET,
            await photo(),
            dto({ issueId: ISSUE }),
            ME,
            abilityOf(MECHANIC_KEYS),
          ),
        ),
      ).toEqual({ status: 400, code: 'ISSUE_NOT_ON_TICKET' });
    });

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
    it('answers 409 PHOTO_LIMIT_REACHED at the photo cap', async () => {
      const s = setup({ photoCount: 5 });
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
      ).toEqual({ status: 409, code: 'PHOTO_LIMIT_REACHED' });
      expect(s.puts).toHaveLength(0);
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
      'VEHICLE_PHOTO',
      'PROOF',
      'RECEIPT',
      'OTHER_DOCUMENT',
    ]);
  });

  it('reports the limits from the settings and counts documents only with costs.view', async () => {
    const s = listSetup([], {
      limits: { maxFileMb: 7, photos: 4, documents: 9 },
      photoCount: 3,
      documentCount: 2,
    });
    const mech = await s.service.list(TICKET, ME, abilityOf(MECHANIC_KEYS));
    expect(mech.limits).toEqual({
      maxFileMb: 7,
      maxVehiclePhotos: 4,
      maxDocuments: 9,
      vehiclePhotoCount: 3,
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
