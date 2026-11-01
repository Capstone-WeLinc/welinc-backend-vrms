import {
  canRemove,
  cleanFileName,
  type RemoveRights,
} from './attachments.service';
import { blobLink, storageConfig } from './blob-file-store';
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

describe('canRemove (AC-17)', () => {
  const rights = (over: Partial<RemoveRights> = {}): RemoveRights => ({
    userId: 'me',
    open: true,
    removeAny: false,
    add: { addFiles: true, addDocuments: false },
    ...over,
  });
  const photo = { kind: 'VEHICLE_PHOTO' as const, uploadedByUserId: 'me' };

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
    const doc = { kind: 'OTHER_DOCUMENT' as const, uploadedByUserId: 'me' };
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
  it('prefers the connection string when both are set', () => {
    const c = storageConfig({
      STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
      STORAGE_ACCOUNT_URL: 'https://acct.blob.core.windows.net',
    });
    expect(c).toMatchObject({ accountUrl: undefined, bothSet: true });
  });

  it('has neither when nothing is set, and the default container', () => {
    expect(storageConfig({})).toMatchObject({
      connectionString: undefined,
      accountUrl: undefined,
      container: 'vrms-attachments',
    });
  });

  it('builds the local link on the browser host, keeping the account in the path', () => {
    const host = storageConfig({
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
