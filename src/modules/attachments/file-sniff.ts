// Spec 0017, AC-4: the file's real type from its first bytes (magic bytes), never its name or the
// browser's type. No dependency.

export type SniffedType =
  'image/jpeg' | 'image/png' | 'image/heic' | 'application/pdf';

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1']);

function startsWith(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buffer[offset + i] === b);
}

/** True when an ISO BMFF `ftyp` box names a HEIF brand, as major or compatible brand. */
function isHeif(buffer: Buffer): boolean {
  if (buffer.length < 16 || buffer.toString('latin1', 4, 8) !== 'ftyp') {
    return false;
  }
  const boxSize = buffer.readUInt32BE(0);
  const end = Math.min(boxSize >= 16 ? boxSize : 16, buffer.length);
  if (HEIF_BRANDS.has(buffer.toString('latin1', 8, 12))) return true;
  // Compatible brands start after the 4 byte minor version
  for (let at = 16; at + 4 <= end; at += 4) {
    if (HEIF_BRANDS.has(buffer.toString('latin1', at, at + 4))) return true;
  }
  return false;
}

export function sniffType(buffer: Buffer): SniffedType | null {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return 'application/pdf';
  }
  if (isHeif(buffer)) return 'image/heic';
  return null;
}

/** A short name for the 415 message: "JPEG", "PDF" and so on. */
export const TYPE_NAMES: Record<SniffedType, string> = {
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/heic': 'HEIC',
  'application/pdf': 'PDF',
};

export function isImageType(
  type: SniffedType,
): type is Exclude<SniffedType, 'application/pdf'> {
  return type !== 'application/pdf';
}
