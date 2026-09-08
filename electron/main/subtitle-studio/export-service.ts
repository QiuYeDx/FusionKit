import { access, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import iconv from 'iconv-lite';
import { StudioError, validateDocument, type SubtitleDocument } from '../../../src/subtitle-studio/domain';

export function sourceBytes(value: SubtitleDocument): Buffer {
  const doc = validateDocument(value);
  return iconv.encode(doc.preservation.rawText, doc.origin.encoding, { addBOM: doc.preservation.bom });
}

export async function unusedOutputPath(directory: string, displayName: string): Promise<string> {
  const name = path.parse(path.basename(displayName));
  for (let index = 0; index < 10000; index++) {
    const candidate = path.join(directory, `${name.name}${index ? ` (${index})` : ''}${name.ext}`);
    try { await access(candidate); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate; throw error; }
  }
  throw new StudioError('output_write_failed');
}

export async function publishSource(doc: SubtitleDocument, authorizedPath: string) {
  const bytes = sourceBytes(doc);
  const temporary = path.join(path.dirname(authorizedPath), `.subtitle-studio-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, authorizedPath);
  } catch { throw new StudioError('output_write_failed'); }
  finally { await rm(temporary, { force: true }).catch(() => undefined); }
}
