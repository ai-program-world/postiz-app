import { BadRequestException } from '@nestjs/common';
import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';

jest.mock('file-type', () => ({
  fileTypeStream: jest.fn(),
}));

import {
  isCompleteMp4,
  mp4MoovCheckStream,
} from './custom.upload.validation';

function makeBox(type: string, payloadSize: number): Buffer {
  const total = 8 + payloadSize;
  const buf = Buffer.alloc(total);
  buf.writeUInt32BE(total, 0);
  buf.write(type, 4, 4, 'latin1');
  return buf;
}

async function runMoovStream(buffer: Buffer, chunkSize = 7): Promise<void> {
  const chunks: Buffer[] = [];
  for (let i = 0; i < buffer.length; i += chunkSize) {
    chunks.push(buffer.subarray(i, i + chunkSize));
  }
  const source = Readable.from(chunks);
  const sink = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  await pipeline(source, mp4MoovCheckStream(), sink);
}

describe('MP4 moov atom validation (#1860)', () => {
  it('accepts faststart MP4 (ftyp + moov + mdat) in both buffer and tiny-chunk stream modes', async () => {
    const mp4 = Buffer.concat([
      makeBox('ftyp', 12),
      makeBox('moov', 24),
      makeBox('mdat', 64),
    ]);
    expect(isCompleteMp4(mp4)).toBe(true);
    await expect(runMoovStream(mp4, 5)).resolves.toBeUndefined();
  });

  it('accepts non-faststart MP4 where moov appears after mdat at the end of the file', async () => {
    const mp4 = Buffer.concat([
      makeBox('ftyp', 12),
      makeBox('mdat', 100),
      makeBox('moov', 32),
    ]);
    expect(isCompleteMp4(mp4)).toBe(true);
    await expect(runMoovStream(mp4, 9)).resolves.toBeUndefined();
  });

  it('rejects incomplete MP4 missing moov atom (ftyp + mdat only)', async () => {
    const incomplete = Buffer.concat([
      makeBox('ftyp', 12),
      makeBox('mdat', 120),
    ]);
    expect(isCompleteMp4(incomplete)).toBe(false);
    await expect(runMoovStream(incomplete, 11)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('rejects truncated MP4 where moov header declares bytes beyond EOF', async () => {
    const ftyp = makeBox('ftyp', 12);
    const truncatedMoov = makeBox('moov', 50).subarray(0, 20);
    const truncated = Buffer.concat([ftyp, truncatedMoov]);
    await expect(runMoovStream(truncated, 6)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });
});
