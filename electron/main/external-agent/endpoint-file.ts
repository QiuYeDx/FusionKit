import { rmSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * `<userData>/external-agent/endpoint.json`: where the running endpoint is and its token,
 * for the stdio bridge. It exists only while FusionKit listens.
 */
export class EndpointFile {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string) {}

  get file() { return path.join(this.directory, "endpoint.json"); }

  publish(endpoint: { url: string; token: string; appVersion: string }): Promise<void> {
    return this.queue(async () => {
      await mkdir(this.directory, { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, ...endpoint, pid: process.pid }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.file);
    });
  }

  clear(): Promise<void> {
    return this.queue(() => rm(this.file, { force: true }));
  }

  /** On quit, when there is no time left for a queued write. */
  clearSync(): void {
    try { rmSync(this.file, { force: true }); } catch { /* a stale file only points at a closed port */ }
  }

  private queue(work: () => Promise<void>): Promise<void> {
    const next = this.writes.then(work).catch(() => undefined);
    this.writes = next;
    return next;
  }
}
