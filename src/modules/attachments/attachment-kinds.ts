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
  VEHICLE_PHOTO: {
    label: 'Vehicle photo',
    accepts: IMAGES,
    acceptsLabel: 'JPEG, PNG or HEIC photos',
    addAction: 'addFiles',
    costsOnly: false,
  },
  PROOF: {
    label: 'Proof of completion',
    accepts: [...IMAGES, 'application/pdf'],
    acceptsLabel: 'JPEG, PNG or HEIC photos and PDF files',
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

/** Kinds counted against uploads.max_documents (AC-9). */
export const DOCUMENT_KINDS: AttachmentKind[] = ['RECEIPT', 'OTHER_DOCUMENT'];

/** The kinds a caller may see on a ticket they can see (AC-16). */
export function visibleKinds(canViewCosts: boolean): AttachmentKind[] {
  return ATTACHMENT_KINDS.filter(
    (k) => canViewCosts || !KIND_RULES[k].costsOnly,
  );
}
