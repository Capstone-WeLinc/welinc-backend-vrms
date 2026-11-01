import heicConvert from 'heic-convert';
import sharp from 'sharp';
import { Semaphore } from './semaphore';

// Spec 0017, AC-6: every stored photo is re-encoded. Upright, sRGB, no metadata, no transparency.

/** Decompression bomb cap: sharp refuses inputs with more pixels than this. */
export const MAX_INPUT_PIXELS = 40_000_000;
const DISPLAY_EDGE = 2048;
const DISPLAY_QUALITY = 82;
const THUMB_SIZE = 320;

export type ProcessedImage = {
  display: Buffer;
  thumbnail: Buffer;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
};

/** The image could not be decoded, or is over the pixel cap (422 FILE_UNREADABLE). */
export class UnreadableImageError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('Image could not be decoded', options);
    this.name = 'UnreadableImageError';
  }
}

// One thread per sharp call keeps CPU and memory steady on a 0.5 vCPU, 1 GiB container
sharp.concurrency(1);

// Per replica: 1 HEIC conversion and 2 other images at once; the rest wait their turn
const heicSlots = new Semaphore(1);
const imageSlots = new Semaphore(2);

/** iPhone HEIC or HEIF to JPEG (quality 0.92), in pure WebAssembly. */
async function heicToJpeg(input: Buffer): Promise<Buffer> {
  try {
    const jpeg = await heicConvert({
      buffer: new Uint8Array(input.buffer, input.byteOffset, input.length),
      format: 'JPEG',
      quality: 0.92,
    });
    return Buffer.from(jpeg);
  } catch (cause) {
    throw new UnreadableImageError({ cause });
  }
}

/**
 * JPEG, PNG or HEIC in; a display JPEG (longest edge 2048, never enlarged) and a 320 px WebP
 * thumbnail out. The original is never kept.
 */
export async function processImage(
  input: Buffer,
  type: 'image/jpeg' | 'image/png' | 'image/heic',
): Promise<ProcessedImage> {
  const decodable =
    type === 'image/heic'
      ? await heicSlots.run(() => heicToJpeg(input))
      : input;
  return imageSlots.run(() => reencode(decodable));
}

async function reencode(input: Buffer): Promise<ProcessedImage> {
  try {
    const { data: display, info } = await sharp(input, {
      limitInputPixels: MAX_INPUT_PIXELS,
    })
      .rotate() // upright from the EXIF orientation
      .toColorspace('srgb') // Display P3 keeps its colors once the profile is dropped
      .flatten({ background: '#ffffff' })
      .resize({
        width: DISPLAY_EDGE,
        height: DISPLAY_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: DISPLAY_QUALITY })
      .toBuffer({ resolveWithObject: true });

    // From the display copy: already upright, small and clean
    const thumbnail = await sharp(display)
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover' })
      .webp()
      .toBuffer();

    return {
      display,
      thumbnail,
      mimeType: 'image/jpeg',
      width: info.width,
      height: info.height,
    };
  } catch (cause) {
    throw new UnreadableImageError({ cause });
  }
}
