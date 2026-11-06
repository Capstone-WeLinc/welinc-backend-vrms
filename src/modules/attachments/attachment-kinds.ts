import { AttachmentKind } from '@prisma/client';
import type { SniffedType } from './file-sniff';

// Spec 0017: per kind, its label, the types it accepts (AC-4) and which add right it needs (AC-15).

export type AddAction = 'addFiles' | 'addDocuments';

export type KindRule = {
  label: string;
  accepts: SniffedType[];
  acceptsLabel: string;
  addAction: AddAction;
  /** Receipts and other documents are cost paperwork: hidden without ticket.costs.view (AC-16). */
  costsOnly: boolean;
};

const IMAGES: SniffedType[] = ['image/jpeg', 'image/png', 'image/heic'];

export const KIND_RULES: Record<AttachmentKind, KindRule> = {
  // Spec 0018: the two photo kinds are the Before and After groups of one strip (AC-2, AC-18)
  VEHICLE_PHOTO: {
    label: 'Before photo',
    accepts: IMAGES,
    acceptsLabel: 'JPEG, PNG or HEIC photos',
    addAction: 'addFiles',
    costsOnly: false,
  },
  PROOF: {
    label: 'After photo',
    accepts: IMAGES,
    acceptsLabel: 'JPEG, PNG or HEIC photos',
    addAction: 'addFiles',
    costsOnly: false,
  },
  RECEIPT: {
    label: 'Receipt',
    accepts: [...IMAGES, 'application/pdf'],
    acceptsLabel: 'JPEG, PNG or HEIC photos and PDF files',
    addAction: 'addDocuments',
    costsOnly: true,
  },
  OTHER_DOCUMENT: {
    label: 'Other document',
    accepts: ['application/pdf'],
    acceptsLabel: 'PDF files',
    addAction: 'addDocuments',
    costsOnly: true,
  },
};

export const ATTACHMENT_KINDS = Object.keys(KIND_RULES) as AttachmentKind[];

/** Spec 0018: the photo kinds, one pool for duplicates (AC-21). The rest are documents. */
export const PHOTO_KINDS: AttachmentKind[] = ['VEHICLE_PHOTO', 'PROOF'];

export function isPhotoKind(kind: AttachmentKind): boolean {
  return PHOTO_KINDS.includes(kind);
}

/** Spec 0018, AC-1: the kind a photo is stored as, from whether work has started. */
export function photoKindFor(workStarted: boolean): AttachmentKind {
  return workStarted ? 'PROOF' : 'VEHICLE_PHOTO';
}

/** Spec 0024, AC-21: the photo group an upload may name (a drop on a zone). */
export const PHOTO_GROUPS = ['BEFORE', 'AFTER'] as const;
export type PhotoGroup = (typeof PHOTO_GROUPS)[number];

/** Spec 0024, AC-21: the kind a named group is stored as. */
export function photoKindForGroup(group: PhotoGroup): AttachmentKind {
  return group === 'AFTER' ? 'PROOF' : 'VEHICLE_PHOTO';
}

/**
 * Spec 0018: what the upload form sends. PHOTO lets the server pick Before or After; the two
 * photo kinds are still accepted from queued uploads in an open tab and treated as PHOTO.
 */
export const UPLOAD_KINDS = [
  'PHOTO',
  'VEHICLE_PHOTO',
  'PROOF',
  'RECEIPT',
  'OTHER_DOCUMENT',
] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

/** The rule a photo upload is checked against before its kind is known: images only (AC-2). */
export const PHOTO_RULE = {
  label: 'Photo',
  accepts: IMAGES,
  acceptsLabel: 'JPEG, PNG or HEIC photos',
} as const;

/** Kinds counted against uploads.max_documents (AC-9). */
export const DOCUMENT_KINDS: AttachmentKind[] = ['RECEIPT', 'OTHER_DOCUMENT'];

/** The kinds a caller may see on a ticket they can see (AC-16). */
export function visibleKinds(canViewCosts: boolean): AttachmentKind[] {
  return ATTACHMENT_KINDS.filter(
    (k) => canViewCosts || !KIND_RULES[k].costsOnly,
  );
}
