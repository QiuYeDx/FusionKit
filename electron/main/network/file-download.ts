import fs from 'node:fs';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import { getNetworkAgents } from './runtime';

export interface FileDownloadOptions {
  /** The proxy-aware agent unless given (tests pass their own). */
  readonly agent?: https.Agent;
  /** A connection that sends nothing for this long is cut instead of waiting forever. */
  readonly idleTimeoutMs?: number;
  readonly maxRedirects?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Downloads an https address to a file through the network settings' proxy, following redirects
 * (relative ones too; https only). It settles once: when the whole file is written, or after a
 * partial file has been removed.
 */
export async function downloadToFile(url: string, targetPath: string, options: FileDownloadOptions = {}): Promise<void> {
  let current = new URL(url);
  for (let hop = 0; ; hop += 1) {
    if (current.protocol !== 'https:') throw new Error('The download address is not https.');
    const location = await downloadOnce(current, targetPath, options);
    if (location === undefined) return;
    if (hop >= (options.maxRedirects ?? DEFAULT_MAX_REDIRECTS)) throw new Error('Too many redirects');
    current = new URL(location, current);
  }
}

/** One GET: resolves with a redirect target, or once the file is complete. */
function downloadOnce(url: URL, targetPath: string, options: FileDownloadOptions): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    let responding = false;
    const request = https.get(url, { agent: options.agent ?? getNetworkAgents().https }, response => {
      responding = true;
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        resolve(response.headers.location);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Download failed with status ${status}`));
        return;
      }
      const expected = Number(response.headers['content-length'] ?? Number.NaN);
      let written = 0;
      response.on('data', (chunk: Buffer) => { written += chunk.length; });
      // A dropped connection or a stalled body fails the pipeline; the partial file is removed first.
      pipeline(response, fs.createWriteStream(targetPath)).then(() => {
        if (Number.isFinite(expected) && written !== expected) throw new Error('Download interrupted');
      }).then(() => resolve(undefined), async (error: unknown) => {
        await fs.promises.unlink(targetPath).catch(() => undefined);
        reject(error instanceof Error ? error : new Error('Download interrupted'));
      });
    });
    request.setTimeout(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, () => request.destroy(
      Object.assign(new Error('Download timed out'), { code: 'ETIMEDOUT' }),
    ));
    // Once the answer has arrived, failures reach the pipeline instead.
    request.on('error', error => { if (!responding) reject(error); });
  });
}
