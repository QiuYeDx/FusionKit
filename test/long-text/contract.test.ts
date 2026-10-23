import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { changeEventSchema, LONG_TEXT_CHANNEL_PREFIX, LONG_TEXT_CHANNELS } from '../../src/long-text/channels';
import {
  endpointSchema, indexSchema, LONG_TEXT_ERROR_CODES, LONG_TEXT_LIMITS, longTextRequestSchemas, modelSchema,
  settingsSchema, type LongTextMethod,
} from '../../src/long-text/contract';

const documentId = randomUUID();
const model = {
  profileId: 'profile-1', label: 'GPT', modelKey: 'gpt-4o', endpoint: 'https://api.example.com/v1',
  apiFormat: 'chat_completions', contextWindow: 131_072, maxOutputTokens: 8_192,
};
const knowledge = { version: 2, languagePair: { source: 'ja', target: 'zh-Hans' }, collectionIds: [randomUUID()], disabledEntryIds: [] };
const settings = {
  sourceLanguage: 'auto', targetLanguage: 'zh-Hans', style: 'literary', instructions: '', knowledge: null,
  profileId: null, pace: 2, batchSourceTokens: 1500, maxOutputTokens: null,
};
const defaults = {
  targetLanguage: 'zh-Hans', style: null, instructions: '', profileId: null, pace: 2, batchSourceTokens: 1500,
  maxOutputTokens: null, knowledgeCollectionIds: [],
};

const validRequests: Record<LongTextMethod, Record<string, unknown>> = {
  list: {},
  pickFiles: { filterName: 'Text', defaults },
  importFiles: { paths: ['C:\\Books\\novel.txt', '/home/me/notes.md', '\\\\server\\share\\a.md'], source: 'drop', defaults },
  importText: { name: 'Pasted', text: 'Hello', format: 'markdown', defaults },
  read: { documentId },
  readPage: { documentId, page: 0 },
  query: { documentId, filter: { kind: 'search', text: 'Alice' }, offset: 0, limit: 100 },
  locate: { documentId, from: 12, direction: 'previous' },
  estimate: { documentId, scope: 'full', contextWindow: 131_072, maxOutputTokens: 8_192 },
  updateSettings: { documentId, expectedRevision: 3, settings, clearTranslations: false },
  confirmEncoding: { documentId },
  previewEncoding: { documentId, encoding: 'gb18030' },
  resegment: { documentId, txtSplit: 'unwrap', discardTranslations: true },
  start: { documentId, kind: 'from', fromIndex: 88, model, apiKey: 'sk-test' },
  retranslate: { documentId, index: 4, rev: 2, instruction: 'More casual.', model, apiKey: 'sk-test' },
  pause: { documentId, immediate: false },
  edit: { documentId, index: 4, rev: 2, text: 'First line\nsecond line' },
  setLocked: { documentId, index: 4, rev: 2, locked: true },
  undo: { documentId, index: 4, rev: 2 },
  dismissFlag: { documentId, index: 4, rev: 2, code: 'length_short' },
  clear: { documentId, keepLocked: true },
  readLedger: { documentId },
  updateLedger: { documentId, upserts: [{ source: 'アリス', target: '爱丽丝', confirmed: true }], deletes: [randomUUID()] },
  chooseExportFolder: { documentId },
  export: { documentId, mode: 'bilingual', destination: 'folder' },
  copy: { documentId, mode: 'target' },
  reveal: { documentId, target: 'export' },
  rename: { documentId, name: '  Renamed  ' },
  remove: { documentId },
};

function parses(method: LongTextMethod, request: unknown): boolean {
  return longTextRequestSchemas[method].safeParse(request).success;
}

describe('channels', () => {
  it('pairs every request schema with one prefixed, distinct channel and keeps changed separate', () => {
    const { changed, ...requests } = LONG_TEXT_CHANNELS;
    expect(Object.keys(requests).sort()).toEqual(Object.keys(longTextRequestSchemas).sort());
    const names = Object.values(LONG_TEXT_CHANNELS);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every(name => name.startsWith(LONG_TEXT_CHANNEL_PREFIX))).toBe(true);
    expect(changed).toBe('long-text:changed');
  });

  it('filters change events', () => {
    const event = { sequence: 7, kind: 'segments', documentId, revision: 2, range: { start: 3, end: 9 }, pages: [0, 1], summary: { any: 'thing' } };
    expect(changeEventSchema.safeParse(event).success).toBe(true);
    expect(changeEventSchema.safeParse({ sequence: 0, kind: 'list', documentId: null }).success).toBe(true);
    for (const invalid of [
      { ...event, extra: true },
      { ...event, sequence: -1 },
      { ...event, sequence: 1.5 },
      { ...event, kind: 'progress' },
      { ...event, documentId: 'not-a-uuid' },
      { ...event, range: { start: -1, end: 2 } },
      { ...event, range: { start: 0, end: 2, more: 1 } },
      { ...event, pages: Array.from({ length: 65 }, (_, page) => page) },
      { sequence: 1, kind: 'list' },
      null,
      'long-text:changed',
    ]) expect(changeEventSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('request schemas', () => {
  it('accept a valid request for every method and reject unknown keys', () => {
    for (const method of Object.keys(longTextRequestSchemas) as LongTextMethod[]) {
      expect(parses(method, validRequests[method]), method).toBe(true);
      expect(parses(method, { ...validRequests[method], unexpected: 1 }), method).toBe(false);
    }
  });

  it('reject a malformed document id everywhere it is required', () => {
    for (const method of Object.keys(longTextRequestSchemas) as LongTextMethod[]) {
      if (!('documentId' in validRequests[method])) continue;
      expect(parses(method, { ...validRequests[method], documentId: 'doc-1' }), method).toBe(false);
    }
  });

  it('trim names and texts before checking their length', () => {
    expect(longTextRequestSchemas.rename.parse(validRequests.rename).name).toBe('Renamed');
    expect(parses('rename', { documentId, name: '   ' })).toBe(false);
    expect(parses('rename', { documentId, name: 'x'.repeat(LONG_TEXT_LIMITS.nameChars + 1) })).toBe(false);
    expect(parses('query', { ...validRequests.query, filter: { kind: 'search', text: '  ' } })).toBe(false);
    expect(parses('query', { ...validRequests.query, filter: { kind: 'search', text: 'x'.repeat(201) } })).toBe(false);
    expect(parses('retranslate', { ...validRequests.retranslate, instruction: 'x'.repeat(501) })).toBe(false);
  });

  it('accept absolute paths only', () => {
    const request = (paths: string[]) => ({ ...validRequests.importFiles, paths });
    expect(parses('importFiles', request(['novel.txt']))).toBe(false);
    expect(parses('importFiles', request(['C:novel.txt']))).toBe(false);
    expect(parses('importFiles', request(['/tmp/a\0b.txt']))).toBe(false);
    expect(parses('importFiles', request([]))).toBe(false);
    expect(parses('importFiles', request(Array.from({ length: 51 }, (_, i) => `/books/${i}.txt`)))).toBe(false);
    expect(parses('importFiles', request(Array.from({ length: 50 }, (_, i) => `/books/${i}.txt`)))).toBe(true);
  });

  it('bound pasted text, edits and query pages', () => {
    expect(parses('importText', { ...validRequests.importText, text: '' })).toBe(false);
    expect(parses('importText', { ...validRequests.importText, format: 'docx' })).toBe(false);
    expect(parses('edit', { ...validRequests.edit, text: '' })).toBe(true);
    expect(parses('edit', { ...validRequests.edit, text: 'x'.repeat(LONG_TEXT_LIMITS.editChars + 1) })).toBe(false);
    expect(parses('query', { ...validRequests.query, limit: 101 })).toBe(false);
    expect(parses('query', { ...validRequests.query, limit: 0 })).toBe(false);
    expect(parses('query', { ...validRequests.query, filter: { kind: 'attention', text: 'x' } })).toBe(false);
    expect(parses('query', { ...validRequests.query, filter: { kind: 'locked' } })).toBe(false);
    expect(parses('dismissFlag', { ...validRequests.dismissFlag, code: 'unknown' })).toBe(false);
    expect(parses('previewEncoding', { ...validRequests.previewEncoding, encoding: 'utf-32' })).toBe(false);
  });

  it('pair fromIndex with "from" runs and resample with sample runs', () => {
    const { fromIndex: _fromIndex, ...full } = { ...validRequests.start, kind: 'full' };
    expect(parses('start', full)).toBe(true);
    expect(parses('start', { ...full, kind: 'from' })).toBe(false);
    expect(parses('start', { ...full, fromIndex: 3 })).toBe(false);
    expect(parses('start', { ...full, kind: 'sample', resample: true })).toBe(true);
    expect(parses('start', { ...full, resample: false })).toBe(false);
    expect(parses('start', { ...full, apiKey: '' })).toBe(false);
  });

  it('bound ledger edits', () => {
    const upsert = { source: 'Alice', target: '爱丽丝', confirmed: false };
    expect(parses('updateLedger', { ...validRequests.updateLedger, upserts: [{ ...upsert, id: randomUUID() }] })).toBe(true);
    expect(parses('updateLedger', { ...validRequests.updateLedger, upserts: [{ ...upsert, source: 'x'.repeat(81) }] })).toBe(false);
    expect(parses('updateLedger', { ...validRequests.updateLedger, upserts: [{ ...upsert, target: ' ' }] })).toBe(false);
    expect(parses('updateLedger', { ...validRequests.updateLedger, upserts: Array(501).fill(upsert) })).toBe(false);
    expect(parses('updateLedger', { ...validRequests.updateLedger, deletes: Array(2001).fill(randomUUID()) })).toBe(false);
  });
});

describe('indexSchema', () => {
  it('allows indices below the segment limit only', () => {
    expect(indexSchema.safeParse(0).success).toBe(true);
    expect(indexSchema.safeParse(199_999).success).toBe(true);
    for (const invalid of [200_000, -1, 1.5, '3', Number.NaN]) expect(indexSchema.safeParse(invalid).success).toBe(false);
    expect(parses('edit', { ...validRequests.edit, index: 200_000 })).toBe(false);
  });
});

describe('settingsSchema', () => {
  it('accepts no materials and a valid selection', () => {
    expect(settingsSchema.safeParse(settings).success).toBe(true);
    expect(settingsSchema.safeParse({ ...settings, knowledge }).success).toBe(true);
    expect(settingsSchema.safeParse({ ...settings, sourceLanguage: 'ko', profileId: 'p', pace: 4, maxOutputTokens: 4096 }).success).toBe(true);
  });

  it('rejects a materials draft whose source language is still empty', () => {
    const draft = { ...knowledge, languagePair: { source: '', target: 'zh-Hans' } };
    expect(settingsSchema.safeParse({ ...settings, knowledge: draft }).success).toBe(false);
  });

  it('rejects values outside the documented ranges', () => {
    for (const patch of [
      { sourceLanguage: 'it' }, { targetLanguage: 'auto' }, { style: 'poetic' }, { pace: 3 },
      { batchSourceTokens: 499 }, { batchSourceTokens: 4001 }, { maxOutputTokens: 1023 }, { maxOutputTokens: 32769 },
      { instructions: 'x'.repeat(4001) }, { profileId: '' }, { knowledge: undefined },
    ]) expect(settingsSchema.safeParse({ ...settings, ...patch }).success, JSON.stringify(patch)).toBe(false);
  });
});

describe('modelSchema', () => {
  it('accepts http and https endpoints without credentials, query or fragment', () => {
    expect(modelSchema.safeParse(model).success).toBe(true);
    expect(modelSchema.safeParse({ ...model, endpoint: 'http://localhost:11434/v1', apiFormat: 'responses', outputTokenParameter: 'max_completion_tokens', thinkingEnabled: false }).success).toBe(true);
    for (const endpoint of [
      'https://user@api.example.com/v1', 'https://user:secret@api.example.com/v1', 'https://api.example.com/v1?key=1',
      'https://api.example.com/v1#frag', 'ftp://api.example.com', 'file:///C:/model', 'not a url', '',
    ]) {
      expect(endpointSchema.safeParse(endpoint).success, endpoint).toBe(false);
      expect(modelSchema.safeParse({ ...model, endpoint }).success, endpoint).toBe(false);
    }
  });

  it('keeps the answer within half of the context window', () => {
    expect(modelSchema.safeParse({ ...model, contextWindow: 16_384, maxOutputTokens: 8_192 }).success).toBe(true);
    expect(modelSchema.safeParse({ ...model, contextWindow: 16_383, maxOutputTokens: 8_192 }).success).toBe(false);
    expect(modelSchema.safeParse({ ...model, contextWindow: 8_191, maxOutputTokens: 1_024 }).success).toBe(false);
    expect(modelSchema.safeParse({ ...model, modelKey: '   ' }).success).toBe(false);
    expect(modelSchema.safeParse({ ...model, apiKey: 'sk' }).success).toBe(false);
  });
});

describe('constants', () => {
  it('are frozen and distinct', () => {
    expect(Object.isFrozen(LONG_TEXT_LIMITS)).toBe(true);
    expect(LONG_TEXT_LIMITS.segments).toBe(200_000);
    expect(new Set(LONG_TEXT_ERROR_CODES).size).toBe(LONG_TEXT_ERROR_CODES.length);
  });
});
