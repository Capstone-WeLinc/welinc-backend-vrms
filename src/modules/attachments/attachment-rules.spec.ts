import {
  canMove,
  canRemove,
  cleanFileName,
  isAddedAfterWorkStarted,
  isProtectedBefore,
  type RemoveRights,
} from './attachments.service';
import { blobLink, storageConfig } from './blob-file-store';
import { testEnv, validateEnv } from '../../config/env';
import {
  attachmentIdFromKey,
  attachmentKeys,
  contentDisposition,
  linkWindow,
} from './file-store';
import { visibleKinds } from './attachment-kinds';

// Spec 0017: the pure rules behind keys, links, names and who may remove what.

const T = 'aaaaaaaa-0000-4000-8000-000000000001';
const A = 'bbbbbbbb-0000-4000-8000-000000000002';

describe('attachmentKeys and attachmentIdFromKey (AC-1)', () => {
  it('follows tickets/<ticketId>/<attachmentId>/file.<ext> and thumb.webp', () => {
    expect(attachmentKeys(T, A, 'jpg', true)).toEqual({
      storageKey: `tickets/${T}/${A}/file.jpg`,
      thumbnailKey: `tickets/${T}/${A}/thumb.webp`,
    });
    expect(attachmentKeys(T, A, 'pdf', false).thumbnailKey).toBeNull();
  });

  it('reads the attachment id back, and nothing from other shapes', () => {
    expect(attachmentIdFromKey(`tickets/${T}/${A}/thumb.webp`)).toBe(A);
    expect(attachmentIdFromKey(`tickets/${T}/file.jpg`)).toBeNull();
    expect(attachmentIdFromKey(`other/${T}/${A}/file.jpg`)).toBeNull();
  });
});

describe('linkWindow (AC-2)', () => {
  it('starts 5 minutes before the boundary and ends 10 minutes after the next one', () => {
    const w = linkWindow(new Date('2026-11-01T08:13:20Z'));
    expect(w.startsOn.toISOString()).toBe('2026-11-01T08:05:00.000Z');
    expect(w.expiresOn.toISOString()).toBe('2026-11-01T08:30:00.000Z');
  });

  it('is the same for every call inside one 10 minute window', () => {
    const a = linkWindow(new Date('2026-11-01T08:10:00Z'));
    const b = linkWindow(new Date('2026-11-01T08:19:59Z'));
    expect(a).toEqual(b);
  });

  it('always leaves 10 to 20 minutes', () => {
    for (const at of ['08:10:00', '08:19:59.999']) {
      const now = new Date(`2026-11-01T${at}Z`);
      const left =
        (linkWindow(now).expiresOn.getTime() - now.getTime()) / 60000;
      expect(left).toBeGreaterThan(10);
      expect(left).toBeLessThanOrEqual(20);
    }
  });
});

describe('contentDisposition', () => {
  it('gives an ASCII fallback and an encoded UTF-8 name', () => {
    expect(contentDisposition('Resibo ñ (1)*.pdf')).toBe(
      `inline; filename="Resibo _ (1)*.pdf"; filename*=UTF-8''Resibo%20%C3%B1%20%281%29%2A.pdf`,
    );
  });

  it('escapes quotes and backslashes in the fallback', () => {
    expect(contentDisposition('a"b\\c.jpg')).toContain('filename="a_b_c.jpg"');
  });
});

describe('cleanFileName (data model)', () => {
  it('drops path parts and control characters', () => {
    expect(cleanFileName('C:\\Users\\me\\photo\u0007.jpg', 'jpg')).toBe(
      'photo.jpg',
    );
    expect(cleanFileName('../../etc/passwd', 'pdf', true)).toBe('passwd.pdf');
  });

  it('forces the stored extension when asked', () => {
    expect(cleanFileName('IMG_0001.HEIC', 'jpg', true)).toBe('IMG_0001.jpg');
    expect(cleanFileName('invoice.exe', 'pdf', true)).toBe('invoice.pdf');
  });

  it('falls back to file.<ext> when nothing is left', () => {
    expect(cleanFileName('  ', 'pdf', true)).toBe('file.pdf');
  });

  it('cuts to 255 and keeps the extension', () => {
    const name = cleanFileName(`${'x'.repeat(300)}.pdf`, 'pdf', true);
    expect(name).toHaveLength(255);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});

// Spec 0024, AC-22: protection reads the upload time against the work start
const STARTED = new Date('2026-11-05T02:00:00.000Z');
const BEFORE_START = new Date('2026-11-05T01:00:00.000Z');
const AFTER_START = new Date('2026-11-05T03:00:00.000Z');

describe('canRemove (AC-17)', () => {
  const rights = (over: Partial<RemoveRights> = {}): RemoveRights => ({
    userId: 'me',
    open: true,
    removeAny: false,
    add: { addFiles: true, addDocuments: false },
    workStartedAt: null,
    protectBefore: true,
    ...over,
  });
  const photo = {
    kind: 'VEHICLE_PHOTO' as const,
    uploadedByUserId: 'me',
    createdAt: BEFORE_START,
  };

  it('lets the uploader remove their own while they hold the add right', () => {
    expect(canRemove(photo, rights())).toBe(true);
    expect(
      canRemove(
        photo,
        rights({ add: { addFiles: false, addDocuments: false } }),
      ),
    ).toBe(false);
  });

  it('never lets someone else remove without remove_any', () => {
    expect(canRemove({ ...photo, uploadedByUserId: 'chief' }, rights())).toBe(
      false,
    );
    expect(
      canRemove(
        { ...photo, uploadedByUserId: 'chief' },
        rights({ removeAny: true }),
      ),
    ).toBe(true);
  });

  it('checks the add right of the file’s kind', () => {
    const doc = { ...photo, kind: 'OTHER_DOCUMENT' as const };
    expect(canRemove(doc, rights())).toBe(false);
    expect(
      canRemove(doc, rights({ add: { addFiles: false, addDocuments: true } })),
    ).toBe(true);
  });

  it('allows nothing on a finished ticket', () => {
    expect(canRemove(photo, rights({ open: false, removeAny: true }))).toBe(
      false,
    );
  });

  it('protects a Before photo once work started, unless remove_any or the switch is off (spec 0018, AC-10)', () => {
    const started = { workStartedAt: STARTED };
    expect(canRemove(photo, rights(started))).toBe(false);
    expect(canRemove(photo, rights({ ...started, removeAny: true }))).toBe(
      true,
    );
    expect(canRemove(photo, rights({ ...started, protectBefore: false }))).toBe(
      true,
    );
    const after = { ...photo, kind: 'PROOF' as const };
    expect(canRemove(after, rights(started))).toBe(true);
  });

  it('lets the uploader remove a Before photo added after work started (spec 0024, AC-22)', () => {
    const late = { ...photo, createdAt: AFTER_START };
    expect(canRemove(late, rights({ workStartedAt: STARTED }))).toBe(true);
  });
});

describe('canMove (spec 0018, AC-9 to AC-11)', () => {
  const rights = (over: Partial<RemoveRights> = {}): RemoveRights => ({
    userId: 'me',
    open: true,
    removeAny: false,
    add: { addFiles: true, addDocuments: false },
    workStartedAt: STARTED,
    protectBefore: true,
    ...over,
  });
  const after = {
    kind: 'PROOF' as const,
    uploadedByUserId: 'me',
    createdAt: AFTER_START,
  };
  const before = {
    kind: 'VEHICLE_PHOTO' as const,
    uploadedByUserId: 'me',
    createdAt: BEFORE_START,
  };

  it('lets the uploader with ticket.files.add move their own After photo', () => {
    expect(canMove(after, rights())).toBe(true);
    expect(
      canMove(after, rights({ add: { addFiles: false, addDocuments: false } })),
    ).toBe(false);
    expect(canMove({ ...after, uploadedByUserId: 'chief' }, rights())).toBe(
      false,
    );
  });

  it('keeps a protected Before photo for remove_any, and frees it before work starts', () => {
    expect(canMove(before, rights())).toBe(false);
    expect(canMove(before, rights({ removeAny: true }))).toBe(true);
    expect(canMove(before, rights({ workStartedAt: null }))).toBe(true);
  });

  it('lets the uploader move a late Before photo back to After (spec 0024, AC-22)', () => {
    expect(canMove({ ...before, createdAt: AFTER_START }, rights())).toBe(true);
  });

  it('never moves a document, and nothing on a finished ticket', () => {
    const doc = { ...after, kind: 'RECEIPT' as const };
    expect(canMove(doc, rights({ removeAny: true }))).toBe(false);
    expect(canMove(after, rights({ open: false, removeAny: true }))).toBe(
      false,
    );
  });
});

describe('isProtectedBefore (spec 0018, AC-10; spec 0024, AC-22)', () => {
  const on = { workStartedAt: STARTED, protectBefore: true };
  const before = { kind: 'VEHICLE_PHOTO' as const, createdAt: BEFORE_START };

  it('protects only a Before photo, only after work started, only while the switch is on', () => {
    expect(isProtectedBefore(before, on)).toBe(true);
    expect(isProtectedBefore({ ...before, kind: 'PROOF' }, on)).toBe(false);
    expect(isProtectedBefore(before, { ...on, workStartedAt: null })).toBe(
      false,
    );
    expect(isProtectedBefore(before, { ...on, protectBefore: false })).toBe(
      false,
    );
  });

  it('follows the upload time: at the work start is protected, after it is not', () => {
    expect(isProtectedBefore({ ...before, createdAt: STARTED }, on)).toBe(true);
    expect(isProtectedBefore({ ...before, createdAt: AFTER_START }, on)).toBe(
      false,
    );
  });
});

describe('isAddedAfterWorkStarted (spec 0024, AC-22)', () => {
  const before = { kind: 'VEHICLE_PHOTO' as const, createdAt: AFTER_START };

  it('marks a Before photo uploaded strictly after the work start', () => {
    expect(isAddedAfterWorkStarted(before, STARTED)).toBe(true);
    expect(
      isAddedAfterWorkStarted({ ...before, createdAt: STARTED }, STARTED),
    ).toBe(false);
    expect(
      isAddedAfterWorkStarted({ ...before, createdAt: BEFORE_START }, STARTED),
    ).toBe(false);
  });

  it('never marks an After photo, or any photo before work started', () => {
    expect(isAddedAfterWorkStarted({ ...before, kind: 'PROOF' }, STARTED)).toBe(
      false,
    );
    expect(isAddedAfterWorkStarted(before, null)).toBe(false);
  });
});

describe('visibleKinds (AC-16)', () => {
  it('hides receipts and other documents without ticket.costs.view', () => {
    expect(visibleKinds(false)).toEqual(['VEHICLE_PHOTO', 'PROOF']);
    expect(visibleKinds(true)).toEqual([
      'VEHICLE_PHOTO',
      'PROOF',
      'RECEIPT',
      'OTHER_DOCUMENT',
    ]);
  });
});

describe('storageConfig and blobLink (AC-3, backend layout)', () => {
  // Through the boot check, so blanks and defaults behave as at startup (spec 0010)
  const storage = (extra: Record<string, string>) =>
    storageConfig(validateEnv({ ...testEnv, ...extra }));

  it('prefers the connection string when both are set', () => {
    const c = storage({
      STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
      STORAGE_ACCOUNT_URL: 'https://acct.blob.core.windows.net',
    });
    expect(c).toMatchObject({
      connectionString: 'UseDevelopmentStorage=true',
      accountUrl: undefined,
    });
  });

  it('has neither when nothing or blanks are set, and the default container', () => {
    expect(
      storage({ STORAGE_CONNECTION_STRING: '  ', STORAGE_ACCOUNT_URL: '' }),
    ).toMatchObject({
      connectionString: undefined,
      accountUrl: undefined,
      container: 'vrms-attachments',
    });
  });

  it('builds the local link on the browser host, keeping the account in the path', () => {
    const host = storage({
      STORAGE_PUBLIC_URL: 'http://localhost:10000/devstoreaccount1/',
    }).publicUrl!;
    expect(
      blobLink(
        host,
        'vrms-attachments',
        `tickets/${T}/${A}/file.jpg`,
        'sv=1&sig=x',
      ),
    ).toBe(
      `http://localhost:10000/devstoreaccount1/vrms-attachments/tickets/${T}/${A}/file.jpg?sv=1&sig=x`,
    );
  });

  it('builds the Azure link on the account URL', () => {
    expect(
      blobLink(
        'https://acct.blob.core.windows.net/',
        'vrms-attachments',
        'tickets/k',
        'sig=y',
      ),
    ).toBe(
      'https://acct.blob.core.windows.net/vrms-attachments/tickets/k?sig=y',
    );
  });
});
