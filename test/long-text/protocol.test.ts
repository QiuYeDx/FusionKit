import { describe, expect, it } from 'vitest';
import { parseBatchResponse, validateTerms } from '../../src/long-text/protocol';

const IDS = ['s1', 's2'];
const MAX = 65_536;
const body = (value: unknown) => JSON.stringify(value);
const items = [{ id: 's1', text: '甲' }, { id: 's2', text: '乙' }];

describe('parseBatchResponse', () => {
  it('returns the items by id and the terms', () => {
    const result = parseBatchResponse(body({ items, terms: [{ source: 'Alice', target: '爱丽丝' }] }), IDS, MAX);
    expect(result).toEqual({ items: new Map([['s1', '甲'], ['s2', '乙']]), terms: [{ source: 'Alice', target: '爱丽丝' }] });
  });

  it('extracts the object from code fences and surrounding text', () => {
    const expected = { items: new Map([['s1', '甲'], ['s2', '乙']]), terms: [] };
    expect(parseBatchResponse(`\`\`\`json\n${body({ items })}\n\`\`\``, IDS, MAX)).toEqual(expected);
    expect(parseBatchResponse(`\`\`\`\n${body({ items })}\n\`\`\`\n`, IDS, MAX)).toEqual(expected);
    expect(parseBatchResponse(`Here is the translation:\n${body({ items })}\nDone.`, IDS, MAX)).toEqual(expected);
  });

  it('ignores unknown top-level keys and unknown keys inside items', () => {
    const content = body({
      notes: 'kept the names', items: [{ id: 's2', text: '乙', comment: 'x', confidence: 0.9 }, { id: 's1', text: '甲', source: 'A' }],
      terms: [], thinking: { steps: [] },
    });
    expect(parseBatchResponse(content, IDS, MAX)).toEqual({ items: new Map([['s2', '乙'], ['s1', '甲']]), terms: [] });
  });

  it('accepts numeric ids as strings', () => {
    expect(parseBatchResponse(body({ items: [{ id: 1, text: 'a' }, { id: '2', text: 'b' }] }), ['1', '2'], MAX))
      .toEqual({ items: new Map([['1', 'a'], ['2', 'b']]), terms: [] });
  });

  it('rejects answers that are not JSON', () => {
    for (const content of ['', 'I cannot translate this.', '{"items": [', '} {', '{items: []}']) {
      expect(parseBatchResponse(content, IDS, MAX), content).toEqual({ error: 'not_json' });
    }
  });

  it('rejects answers without an items array of { id, text }', () => {
    const shapes: unknown[] = [
      {}, { items: {} }, { items: 'a' }, { result: items },
      { items: [...items, 'text'] }, { items: [...items, null] }, { items: [...items, ['s3', 'c']] },
      { items: [{ id: 's1' }, items[1]] }, { items: [{ id: 's1', text: 1 }, items[1]] }, { items: [{ text: '甲' }, items[1]] },
      { items: [{ id: null, text: '甲' }, items[1]] }, { items: [{ id: { v: 's1' }, text: '甲' }, items[1]] },
    ];
    for (const shape of shapes) expect(parseBatchResponse(body(shape), IDS, MAX), body(shape)).toEqual({ error: 'shape' });
  });

  it('rejects answers whose ids are not exactly the expected ones', () => {
    const cases = [
      [items[0]],
      [...items, { id: 's3', text: '丙' }],
      [items[0], { id: 's1', text: '甲2' }],
      [items[0], { id: 's9', text: '乙' }],
      [items[0], items[1], { id: 's2', text: '乙2' }],
      [],
    ];
    for (const list of cases) expect(parseBatchResponse(body({ items: list }), IDS, MAX), body(list)).toEqual({ error: 'ids' });
    expect(parseBatchResponse(body({ items }), ['s1', 's1'], MAX)).toEqual({ error: 'ids' });
  });

  it('rejects answers over the byte limit, counting UTF-8 bytes', () => {
    const ascii = body({ items: [{ id: 's1', text: 'a' }, { id: 's2', text: 'b' }] });
    expect(parseBatchResponse(ascii, IDS, ascii.length)).not.toHaveProperty('error');
    expect(parseBatchResponse(ascii, IDS, ascii.length - 1)).toEqual({ error: 'too_large' });
    const wide = body({ items: [{ id: 's1', text: '中'.repeat(100) }, items[1]] });
    expect(new TextEncoder().encode(wide).length - wide.length).toBe(200 + 2);
    expect(parseBatchResponse(wide, IDS, wide.length + 100)).toEqual({ error: 'too_large' });
    expect(parseBatchResponse(wide, IDS, wide.length + 202)).not.toHaveProperty('error');
  });

  it('never fails a batch over its terms', () => {
    const invalid: unknown[] = [
      'Alice=爱丽丝', { source: 'a', target: 'b' }, null, 3,
      Array.from({ length: 11 }, (_, k) => ({ source: `n${k}`, target: `名${k}` })),
    ];
    for (const terms of invalid) {
      expect(parseBatchResponse(body({ items, terms }), IDS, MAX)).toEqual({ items: new Map([['s1', '甲'], ['s2', '乙']]), terms: [] });
    }
  });
});

describe('validateTerms', () => {
  it('keeps trimmed { source, target } strings of 1–80 characters and drops other entries', () => {
    const long = 'x'.repeat(81);
    expect(validateTerms([
      { source: ' Alice ', target: '爱丽丝', note: 'protagonist' },
      { source: 'Bob' },
      { source: 'Carol', target: 3 },
      { source: '  ', target: '空' },
      { source: long, target: '长' },
      { source: 'Dave', target: long },
      { source: 'x'.repeat(80), target: '八十' },
      'Eve',
      null,
      ['Frank', '弗兰克'],
    ])).toEqual([{ source: 'Alice', target: '爱丽丝' }, { source: 'x'.repeat(80), target: '八十' }]);
  });

  it('keeps up to ten terms and drops anything else as a whole', () => {
    const ten = Array.from({ length: 10 }, (_, k) => ({ source: `n${k}`, target: `名${k}` }));
    expect(validateTerms(ten)).toEqual(ten);
    expect(validateTerms([...ten, { source: 'n10', target: '名10' }])).toEqual([]);
    expect(validateTerms(undefined)).toEqual([]);
    expect(validateTerms({ source: 'a', target: 'b' })).toEqual([]);
    expect(validateTerms([])).toEqual([]);
  });
});
