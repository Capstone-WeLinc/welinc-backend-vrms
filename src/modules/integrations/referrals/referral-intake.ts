import { createHash } from 'node:crypto';
import type { RepairReferralDto } from './repair-referral.dto';

// Spec 0029 (child 0002): the pure parts of the referral intake.

const LABEL_MAX = 200;
const NOTE_MAX = 2000;
const REMARKS_MAX = 4000;
const WO_MAX = 40;
const PLATE_MAX = 20;
export const EMPTY_FINDING_LABEL = 'Finding';

/** JSON with every object's keys sorted, so the same body always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** SHA 256 of the canonical body as received, before any cutting. */
export const payloadHash = (body: unknown) =>
  createHash('sha256').update(canonicalJson(body)).digest('hex');

const cut = (value: string | null | undefined, max: number) => {
  const text = (value ?? '').trim();
  return text.length > max ? text.slice(0, max) : text;
};

export type StoredFinding = {
  checklistItemId: string;
  label: string;
  note: string | null;
};

/** The referral's text as stored: trimmed, cut to the column, empty notes and remarks null. */
export function storedReferral(dto: RepairReferralDto) {
  return {
    vehiclePlate: cut(dto.vehiclePlate, PLATE_MAX),
    workOrderNumber: cut(dto.workOrderNumber, WO_MAX),
    chiefMechanicRemarks: cut(dto.chiefMechanicRemarks, REMARKS_MAX) || null,
    findings: dto.findings.map((f): StoredFinding => ({
      checklistItemId: cut(f.checklistItemId, 100),
      label: cut(f.label, LABEL_MAX) || EMPTY_FINDING_LABEL,
      note: cut(f.note, NOTE_MAX) || null,
    })),
  };
}
