import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LongTextFormat, TxtSplit } from '../../src/long-text/contract';
import * as inline from '../../src/long-text/inline';
import { emptyUsage } from '../../src/long-text/journal';
import type { DocumentManifest, RunRecord, TranslationRecord, TranslationState } from '../../src/long-text/model';
import { segmentDocument } from '../../src/long-text/segments';
import type { NewDocument } from '../../electron/main/long-text/repository';

export const AT = 1_761_100_000_000;
export const RUN_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
export const PENDING: TranslationState = { status: 'pending', target: null, origin: null, locked: false, flags: [], failure: null };

export async function temporaryRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'long-text-store-'));
}

export async function removeRoot(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** A document as the importer would hand it to the repository: segmented with the real inline module. */
export async function buildDocument(S: string, options: { format?: LongTextFormat; txtSplit?: TxtSplit; id?: string; name?: string; original?: Uint8Array } = {}): Promise<NewDocument> {
  const format = options.format ?? 'txt';
  const segmented = await segmentDocument(format, S, { txtSplit: options.txtSplit ?? 'line', inline });
  const translatable = segmented.records.filter(record => record.t).length;
  const manifest: DocumentManifest = {
    schemaVersion: 1, id: options.id ?? randomUUID(), revision: 0, createdAt: AT, updatedAt: AT,
    name: options.name ?? (format === 'txt' ? 'novel.txt' : 'guide.md'), format,
    source: { kind: 'paste' }, encoding: null, lineEnding: '\n',
    structure: segmented.structure,
    detected: { sourceLanguage: 'en', style: segmented.detectedStyle },
    stats: {
      characters: S.length, segments: segmented.records.length, translatable, pages: segmented.pages.length,
      sourceTokens: segmented.records.reduce((sum, record) => sum + (record.t ? record.n : 0), 0),
    },
    settings: {
      sourceLanguage: 'auto', targetLanguage: 'zh-Hans', style: 'general', instructions: '', knowledge: null, profileId: null,
      pace: 2, batchSourceTokens: 1500, maxOutputTokens: null,
    },
    counts: { translatable, done: 0, pending: translatable, failed: 0, attention: 0, edited: 0, locked: 0 },
    usage: emptyUsage(), fullRunStarted: false, sample: null, runs: [], exportFolder: null, exports: [],
  };
  return { manifest, source: S, original: options.original ?? null, records: segmented.records, pages: segmented.pages, refs: segmented.refs };
}

/** `count` lines of English text, one segment each in line mode. */
export function lines(count: number, text: (index: number) => string = index => `Line number ${index} of the story.`): string {
  return Array.from({ length: count }, (_, index) => text(index)).join('\n');
}

export function translated(index: number, rev: number, target: string, extra: Partial<TranslationRecord> = {}): TranslationRecord {
  return { index, rev, status: 'done', target, origin: 'model', locked: false, flags: [], failure: null, previous: PENDING, runId: RUN_ID, at: AT + index, ...extra };
}

export function run(extra: Partial<RunRecord> = {}): RunRecord {
  return {
    id: RUN_ID, kind: 'full', status: 'running', startedAt: AT, settingsDigest: 'digest',
    model: { profileId: 'profile', modelKey: 'deepseek-v4', label: 'DeepSeek V4' }, total: 10, done: 2, failed: 0, deferred: 0, ...extra,
  };
}
