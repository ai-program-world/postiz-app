import { BadRequestException } from '@nestjs/common';
import { pipeline, Readable, Transform } from 'stream';
import { IUploadProvider } from './upload.interface';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fileTypeStream } = require('file-type');

// What users may put in the media library, whether by multipart upload or
// from a remote URL; narrower than what storage itself accepts, audio is
// only mp3 (podcast episodes)
export const UPLOAD_ALLOWED_MIME = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/tiff',
  'video/mp4',
  'audio/mpeg',
]);

export function getMaxSize(mimeType: string): number {
  if (mimeType.startsWith('image/')) {
    return 10 * 1024 * 1024; // 10 MB
  } else if (mimeType.startsWith('video/')) {
    return 1024 * 1024 * 1024; // 1 GB
  } else if (mimeType.startsWith('audio/')) {
    return 500 * 1024 * 1024; // 500 MB
  } else {
    throw new BadRequestException('Unsupported file type.');
  }
}

export const INCOMPLETE_MP4_ERROR =
  'Video file is corrupted or incomplete (missing moov atom). This usually means the file was uploaded before the encoder finished writing it — wait for the render to complete and upload it again.';

// A playable mp4 must contain a top-level moov box (the index of the file).
// Encoders write it last (or rewrite the file with it first for faststart),
// so a file grabbed mid-encode has only ftyp + mdat and can't be played or
// published anywhere.
export function isCompleteMp4(buffer: Buffer): boolean {
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    let size: number = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    if (type === 'moov') {
      return true;
    }
    if (size === 0) {
      // box extends to end of file
      return false;
    }
    if (size === 1) {
      if (offset + 16 > buffer.length) {
        return false;
      }
      const largeSize = buffer.readBigUInt64BE(offset + 8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        return false;
      }
      size = Number(largeSize);
      // a largesize box header is 16 bytes, so smaller values are malformed
      if (size < 16) {
        return false;
      }
    }
    if (size < 8) {
      return false;
    }
    offset += size;
  }
  return false;
}

// Streaming equivalent of isCompleteMp4: walks top-level ISO-BMFF box headers
// keeping at most 16 header bytes in memory across chunk boundaries.
export function mp4MoovCheckStream() {
  let pos = 0;
  let targetOffset = 0;
  let headerBuf: Buffer = Buffer.alloc(0);
  let foundMoov = false;
  let moovEndOffset = 0;
  let malformed = false;

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      while (
        !foundMoov &&
        !malformed &&
        targetOffset !== Infinity &&
        pos + chunk.length > targetOffset
      ) {
        const startInChunk = targetOffset >= pos ? targetOffset - pos : 0;
        const needed = 16 - headerBuf.length;
        if (needed > 0 && startInChunk < chunk.length) {
          const slice = chunk.subarray(
            startInChunk,
            Math.min(chunk.length, startInChunk + needed)
          );
          headerBuf = headerBuf.length
            ? Buffer.concat([headerBuf, slice])
            : Buffer.from(slice);
        }

        if (headerBuf.length < 8) {
          break;
        }

        let size = headerBuf.readUInt32BE(0);
        const type = headerBuf.toString('latin1', 4, 8);

        if (size === 1) {
          if (headerBuf.length < 16) {
            break;
          }
          const largeSize = headerBuf.readBigUInt64BE(8);
          if (
            largeSize < BigInt(16) ||
            largeSize > BigInt(Number.MAX_SAFE_INTEGER)
          ) {
            malformed = true;
            break;
          }
          size = Number(largeSize);
        } else if (size === 0) {
          if (type === 'moov') {
            foundMoov = true;
            moovEndOffset = 0;
          }
          targetOffset = Infinity;
          headerBuf = Buffer.alloc(0);
          break;
        } else if (size < 8) {
          malformed = true;
          break;
        }

        if (type === 'moov') {
          foundMoov = true;
          moovEndOffset = targetOffset + size;
          headerBuf = Buffer.alloc(0);
          break;
        }

        targetOffset += size;
        headerBuf = Buffer.alloc(0);
      }

      pos += chunk.length;
      callback(null, chunk);
    },
    flush(callback) {
      if (!foundMoov || pos < moovEndOffset) {
        return callback(new BadRequestException(INCOMPLETE_MP4_ERROR));
      }
      callback();
    },
  });
}

// Passes bytes through and fails once they exceed maxSize, so a body with a
// missing or lying Content-Length cannot be streamed into storage unbounded
export function maxSizeStream(maxSize: number) {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxSize) {
        return callback(new BadRequestException('File is too large.'));
      }
      callback(null, chunk);
    },
  });
}

// Sniffs the real type from the first bytes, applies the per-type size cap
// and streams the rest into storage, so only the sniffing prefix and a few
// upload parts are ever in memory. Rejections are BadRequestException with
// the same messages the old buffer validation used. `declaredSize` is the
// Content-Length when the sender gave one; it may be absent or wrong, so the
// stream cap is what really enforces the limit
export async function uploadStreamToStorage(
  storage: IUploadProvider,
  webStream: ReadableStream,
  declaredSize = 0
) {
  let sniffed: ReadableStream & { fileType?: { mime: string; ext: string } };
  try {
    sniffed = await fileTypeStream(webStream);
  } catch (err) {
    throw new BadRequestException('Failed to read file', { cause: err });
  }
  const detected = sniffed.fileType;
  if (!detected || !UPLOAD_ALLOWED_MIME.has(detected.mime)) {
    await sniffed.cancel();
    throw new BadRequestException('Unsupported file type.');
  }

  const maxSize = getMaxSize(detected.mime);
  if (declaredSize > maxSize) {
    await sniffed.cancel();
    throw new BadRequestException('File is too large.');
  }

  // pipeline (not pipe) so failing the cap or moov check also tears down the source
  const streams: any[] = [
    Readable.fromWeb(sniffed as any),
    maxSizeStream(maxSize),
  ];
  if (detected.mime === 'video/mp4') {
    streams.push(mp4MoovCheckStream());
  }
  const body = (pipeline as any)(...streams, () => {});

  try {
    const uploaded = await storage.uploadStream(
      body,
      detected.mime,
      detected.ext
    );
    return { ...uploaded, ext: detected.ext };
  } catch (err) {
    // The size cap rejects mid-upload with its own BadRequestException
    body.destroy();
    throw err;
  }
}
