import sharp from 'sharp';
import { processImage, UnreadableImageError } from './image-pipeline';

// Spec 0017, AC-6: re-encoded, upright, no metadata, at most 2048 px, a 320 px WebP thumbnail.

function solid(width: number, height: number, alpha = false) {
  return sharp({
    create: {
      width,
      height,
      channels: alpha ? 4 : 3,
      background: alpha ? { r: 0, g: 0, b: 0, alpha: 0 } : '#3366cc',
    },
  });
}

describe('processImage', () => {
  it('shrinks the longest edge to 2048 and writes a JPEG and a WebP thumbnail', async () => {
    const input = await solid(4000, 3000).jpeg().toBuffer();
    const out = await processImage(input, 'image/jpeg');
    expect(out).toMatchObject({
      mimeType: 'image/jpeg',
      width: 2048,
      height: 1536,
    });
    expect((await sharp(out.display).metadata()).format).toBe('jpeg');
    const thumb = await sharp(out.thumbnail).metadata();
    expect(thumb).toMatchObject({ format: 'webp', width: 320, height: 320 });
  });

  it('never enlarges a small photo', async () => {
    const input = await solid(640, 480).png().toBuffer();
    const out = await processImage(input, 'image/png');
    expect([out.width, out.height]).toEqual([640, 480]);
  });

  it('turns the photo upright and drops EXIF, GPS and ICC', async () => {
    // Orientation 6 means "rotate 90° clockwise to view"
    const input = await solid(400, 200)
      .withMetadata({ orientation: 6 })
      .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '14/1 35/1 0/1' } })
      .jpeg()
      .toBuffer();
    const out = await processImage(input, 'image/jpeg');
    expect([out.width, out.height]).toEqual([200, 400]);
    const meta = await sharp(out.display).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it('flattens transparency onto white', async () => {
    const input = await solid(50, 50, true).png().toBuffer();
    const out = await processImage(input, 'image/png');
    const { data } = await sharp(out.display)
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(245);
  });

  it('rejects bytes that do not decode', async () => {
    const junk = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.alloc(64, 7),
    ]);
    await expect(processImage(junk, 'image/jpeg')).rejects.toBeInstanceOf(
      UnreadableImageError,
    );
  });

  it('rejects an image over the 40 MP pixel cap (decompression bomb)', async () => {
    // 8000 × 6000 = 48 MP of one colour compresses to a few kilobytes
    const bomb = await solid(8000, 6000)
      .png({ compressionLevel: 9 })
      .toBuffer();
    await expect(processImage(bomb, 'image/png')).rejects.toBeInstanceOf(
      UnreadableImageError,
    );
  });

  it('rejects a HEIC that does not decode', async () => {
    await expect(
      processImage(
        Buffer.from('\0\0\0\x18ftypheic not really', 'latin1'),
        'image/heic',
      ),
    ).rejects.toBeInstanceOf(UnreadableImageError);
  });
});
