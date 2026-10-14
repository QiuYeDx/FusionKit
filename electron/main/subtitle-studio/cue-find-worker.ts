import { Worker } from 'node:worker_threads';
import { CUE_FIND_PATTERN_TIMEOUT_MS, matchCueText, validCueFindPattern, type CueFindMatch, type CueFindOptions } from '../../../src/subtitle-studio/cue-find-query';
import { searchDocument, searchTexts, type CueFindField, type CueFindResult } from '../../../src/subtitle-studio/cue-find';
import { StudioError, type SubtitleDocument } from '../../../src/subtitle-studio/domain';

/**
 * The worker's program: the shared matcher's own source, run over the texts it is given.
 * `__name` is defined because a bundler keeping function names may wrap inner functions with it.
 */
const WORKER_SOURCE = `const { parentPort, workerData } = require('node:worker_threads');
var __name = (fn) => fn;
const matchCueText = ${matchCueText.toString()};
const found = workerData.texts.map((text) => matchCueText(text, workerData.query, workerData.options));
parentPort.postMessage(workerData.countOnly ? found.map((matches) => matches.length) : found);`;

function inWorker<T>(data: { texts: string[]; query: string; options: CueFindOptions; countOnly: boolean }, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: data });
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      settle();
    };
    // A regular expression cannot be interrupted from inside; stopping the thread is the only way.
    const timer = setTimeout(() => finish(() => reject(new StudioError('pattern_too_slow'))), timeoutMs);
    worker.once('message', (value: T) => finish(() => resolve(value)));
    worker.once('error', error => finish(() => reject(error instanceof SyntaxError ? new StudioError('invalid_pattern') : error)));
    worker.once('exit', code => finish(() => reject(new Error(`Find worker stopped (${code})`))));
  });
}

/**
 * The matches of a regular expression query in each text, found in a worker thread that is
 * stopped after `timeoutMs`: a pattern that backtracks badly never blocks the main process.
 */
export function regexMatches(texts: string[], query: string, options: CueFindOptions, timeoutMs = CUE_FIND_PATTERN_TIMEOUT_MS): Promise<CueFindMatch[][]> {
  if (!validCueFindPattern(query)) return Promise.reject(new StudioError('invalid_pattern'));
  return inWorker<CueFindMatch[][]>({ texts, query, options: { ...options, regex: true }, countOnly: false }, timeoutMs);
}

/** The search channel's result: literal queries match here, regular expressions in a worker. */
export async function searchCuesInDocument(doc: SubtitleDocument, request: { query: string; field: CueFindField; trackId?: string } & CueFindOptions, timeoutMs = CUE_FIND_PATTERN_TIMEOUT_MS): Promise<CueFindResult> {
  if (!request.regex) return searchDocument(doc, request);
  if (!validCueFindPattern(request.query)) throw new StudioError('invalid_pattern');
  const items = searchTexts(doc, request);
  const texts: string[] = [];
  const slots = new Map<string, number>();
  for (const item of items) for (const field of ['source', 'target'] as const) {
    const text = item[field];
    if (text === undefined) continue;
    slots.set(`${item.index}:${field}`, texts.length);
    texts.push(text);
  }
  const counts = await inWorker<number[]>({ texts, query: request.query, options: request, countOnly: true }, timeoutMs);
  return searchDocument(doc, request, undefined, (_text, at) => counts[slots.get(`${at.index}:${at.field}`)!] ?? 0);
}

/** Text slots of a replace edit: each cue's source and/or translation, keyed as `applyCueEdit` reads them. */
export const replaceMatchKey = (cueId: string, field: 'source' | 'target') => `${cueId}\u0000${field}`;
export type ReplaceMatches = Map<string, CueFindMatch[]>;

/**
 * Finds a regular expression replace edit's matches before the document transaction, so the
 * transaction itself never runs the pattern. `texts` are the slots the edit reads.
 */
export async function replaceMatches(slots: { key: string; text: string }[], query: string, options: CueFindOptions, timeoutMs = CUE_FIND_PATTERN_TIMEOUT_MS): Promise<ReplaceMatches> {
  const found = await regexMatches(slots.map(slot => slot.text), query, options, timeoutMs);
  return new Map(slots.map((slot, index) => [slot.key, found[index]]));
}
