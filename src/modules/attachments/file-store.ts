import { ServiceUnavailableException } from '@nestjs/common';

// Spec 0017: the one seam between VRMS and file storage. Only blob-file-store.ts talks to Azure.

export const FILE_STORE = Symbol('FILE_STORE');

export type StoredFile = {
  key: string;
  body: Buffer;
  contentType: string;
  fileName: string;
};

export type ListedBlob = { name: string; createdOn: Date | undefined };

export interface FileStore {
  /** False when neither STORAGE_CONNECTION_STRING nor STORAGE_ACCOUNT_URL is set (AC-3). */
  readonly configured: boolean;
  put(file: StoredFile): Promise<void>;
  /** Deletes one blob; a missing blob counts as deleted. */
  delete(key: string): Promise<void>;
  /** A read only link for exactly one blob, valid for the window of AC-2. */
  readUrl(
    key: string,
    fileName: string,
    contentType: string,
    now?: Date,
  ): Promise<string>;
  /** Every blob under a prefix, with the time it was first written. */
  list(prefix: string): AsyncIterable<ListedBlob>;
}

export const STORAGE_UNAVAILABLE_MESSAGE =
  'File storage is not available right now.';

export class StorageUnavailableException extends ServiceUnavailableException {
  constructor() {
    super({
      statusCode: 503,
      code: 'STORAGE_UNAVAILABLE',
      message: STORAGE_UNAVAILABLE_MESSAGE,
    });
  }
}

const TEN_MINUTES = 10 * 60 * 1000;

/**
 * AC-2: a stable link window, so every list call inside one 10 minute window returns the same URL
 * and the browser cache can reuse it. Starts at the current boundary minus 5 minutes (clock skew),
 * ends at the next boundary plus 10 minutes, so a link always has 10 to 20 minutes left.
 */
export function linkWindow(now: Date = new Date()) {
  const boundary = Math.floor(now.getTime() / TEN_MINUTES) * TEN_MINUTES;
  return {
    startsOn: new Date(boundary - TEN_MINUTES / 2),
    expiresOn: new Date(boundary + 2 * TEN_MINUTES),
  };
}

/** The Cache-Control a link forces (AC-2). */
export const LINK_CACHE_CONTROL = 'private, max-age=600';

/**
 * One Content-Disposition string, used for the blob property and the SAS override:
 * inline; filename="<ASCII fallback>"; filename*=UTF-8''<encoded>.
 */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** The blob keys of AC-1. */
export function attachmentKeys(
  ticketId: string,
  attachmentId: string,
  ext: string,
  withThumbnail: boolean,
) {
  const base = `tickets/${ticketId}/${attachmentId}`;
  return {
    storageKey: `${base}/file.${ext}`,
    thumbnailKey: withThumbnail ? `${base}/thumb.webp` : null,
  };
}

/** The attachment id inside a key under tickets/, or null for any other shape. */
export function attachmentIdFromKey(key: string): string | null {
  const match = /^tickets\/[0-9a-f-]{36}\/([0-9a-f-]{36})\//i.exec(key);
  return match ? match[1].toLowerCase() : null;
}
