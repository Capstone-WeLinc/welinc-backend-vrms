import { sniffType } from './file-sniff';

// Spec 0017, AC-4: the type comes from the first bytes only.

function heif(major: string, compatible: string[] = []) {
  const brands = [major, '\0\0\0\0', ...compatible].join('');
  const size = 8 + brands.length;
  const head = Buffer.alloc(4);
  head.writeUInt32BE(size);
  return Buffer.concat([head, Buffer.from(`ftyp${brands}`, 'latin1')]);
}

describe('sniffType', () => {
  it.each([
    ['JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'image/jpeg'],
    [
      'PNG',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
      'image/png',
    ],
    ['PDF', Buffer.from('%PDF-1.7\n'), 'application/pdf'],
    ['HEIC major brand', heif('heic'), 'image/heic'],
    ['HEIF via mif1', heif('mif1'), 'image/heic'],
    [
      'HEIC as a compatible brand',
      heif('isom', ['mif1', 'heic']),
      'image/heic',
    ],
  ])('detects %s', (_name, buffer, expected) => {
    expect(sniffType(buffer)).toBe(expected);
  });

  it.each([
    ['a Windows executable', Buffer.from('MZ\x90\0\x03\0\0\0', 'latin1')],
    ['plain text', Buffer.from('hello world')],
    ['an MP4 video', heif('isom', ['mp41'])],
    ['an empty buffer', Buffer.alloc(0)],
    ['a truncated PNG signature', Buffer.from([0x89, 0x50, 0x4e])],
    ['%PDF without the dash', Buffer.from('%PDF1.7')],
  ])('rejects %s', (_name, buffer) => {
    expect(sniffType(buffer)).toBeNull();
  });
});
