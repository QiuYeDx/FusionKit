import { open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import iconv from 'iconv-lite';
import { LIMITS, StudioError, type Encoding } from '../../../src/subtitle-studio/domain';
import { importSubtitleText } from '../../../src/subtitle-studio/formats/import';
import { captureSourceInput, verifySourceLocation } from './source-location-service';

export function decodeSubtitle(bytes: Buffer, encoding: Encoding): { text: string; bom: boolean } {
  if (bytes.length > LIMITS.inputBytes) throw new StudioError('limit_exceeded');
  const bom = encoding === 'utf-8' ? bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])) : encoding === 'utf-16le' && bytes.subarray(0, 2).equals(Buffer.from([255, 254]));
  const payload = bom ? bytes.subarray(encoding === 'utf-8' ? 3 : 2) : bytes;
  try {
    const text = encoding === 'utf-8' ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload) : iconv.decode(payload, encoding, { stripBOM: false });
    if (text.includes('\u0000') || text.includes('\ufffd') || !iconv.encode(text, encoding).equals(payload)) throw new Error('Non-roundtrippable encoding');
    return { text, bom };
  } catch { throw new StudioError('encoding_required'); }
}

export async function readSubtitle(filePath: string, encoding: Encoding) {
  const format = path.extname(filePath).slice(1).toLowerCase();
  if (!['srt', 'lrc', 'vtt', 'ass'].includes(format)) throw new StudioError('unsupported_feature');
  const file = await open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new StudioError('invalid_input');
    if (stat.size > LIMITS.inputBytes) throw new StudioError('limit_exceeded');
    // Bounded read also handles a source that grows after stat.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, LIMITS.inputBytes + 1));
    let size = 0;
    while (size < bytes.length) {
      const result = await file.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > stat.size) throw new StudioError('invalid_input');
    const content = bytes.subarray(0, size);
    const { text, bom } = decodeSubtitle(content, encoding);
    return importSubtitleText(text, { format: format as 'srt' | 'lrc' | 'vtt' | 'ass', displayName: path.basename(filePath), encoding, digest: createHash('sha256').update(content).digest('hex') }, randomUUID, bom);
  } finally { await file.close(); }
}

/** Native picker and private File-drop callers share this bounded read and source identity capture. */
export async function readSubtitleWithSource(filePath: string, encoding: Encoding) {
  const sourceLocation = await captureSourceInput(filePath);
  const document = await readSubtitle(sourceLocation.origin === 'input' ? sourceLocation.inputPath : filePath, encoding);
  await verifySourceLocation(sourceLocation);
  return { document, sourceLocation };
}
