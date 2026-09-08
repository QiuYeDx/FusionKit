import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { idSchema, LIMITS, StudioError, validateDocument, type SubtitleDocument } from '../../../src/subtitle-studio/domain';

export class DocumentRepository {
  constructor(private readonly root: string) {}

  private directory(id: string) {
    if (!idSchema.safeParse(id).success) throw new StudioError('invalid_input');
    return path.join(this.root, id);
  }

  async create(value: SubtitleDocument): Promise<SubtitleDocument> {
    const doc = validateDocument(value);
    const json = JSON.stringify({ schemaVersion: 1, document: doc, tasks: [] });
    if (Buffer.byteLength(json) > LIMITS.snapshotBytes) throw new StudioError('limit_exceeded');
    await mkdir(this.root, { recursive: true });
    const directory = this.directory(doc.id);
    await mkdir(directory);
    const generation = randomUUID();
    try {
      await this.writeSynced(path.join(directory, `${generation}.json`), json);
      await this.writeSynced(path.join(directory, 'current.tmp'), JSON.stringify({ generation }));
      await rename(path.join(directory, 'current.tmp'), path.join(directory, 'current.json'));
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return doc;
  }

  private async writeSynced(filePath: string, content: string) {
    const handle = await open(filePath, 'wx', 0o600);
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
  }

  async read(id: string): Promise<SubtitleDocument> {
    const directory = this.directory(id);
    try {
      const pointer = JSON.parse(await readFile(path.join(directory, 'current.json'), 'utf8'));
      if (!idSchema.safeParse(pointer.generation).success) throw new Error('Invalid generation');
      const file = await open(path.join(directory, `${pointer.generation}.json`), 'r');
      try {
        if ((await file.stat()).size > LIMITS.snapshotBytes) throw new Error('Oversized snapshot');
        const snapshot = JSON.parse(await file.readFile('utf8'));
        if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.tasks) || snapshot.tasks.length) throw new Error('Invalid snapshot');
        const doc = validateDocument(snapshot.document);
        if (doc.id !== id) throw new Error('Identity mismatch');
        return doc;
      } finally { await file.close(); }
    } catch { throw new StudioError('document_unavailable'); }
  }

  async list(): Promise<SubtitleDocument[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    const docs: SubtitleDocument[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && idSchema.safeParse(entry.name).success) docs.push(await this.read(entry.name));
    }
    return docs;
  }
}
