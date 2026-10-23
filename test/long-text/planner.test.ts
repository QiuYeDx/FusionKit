import { describe, expect, it } from 'vitest';
import type { ModelRuntimeTextRequest } from '../../electron/main/ai/model-runtime-client';
import {
  batchContext, boostedOutputTokens, estimate, estimateDocument, familyBudget, firstUnit, fitRequest, requestTokenEstimate, selectUnit,
  serializeRequest, unitLimits,
  type DraftOptions, type RequestDraft,
} from '../../electron/main/long-text/planner';
import { buildPayload, STYLE_PROMPTS, systemPrompt } from '../../electron/main/long-text/prompt';
import { memoryDocument, storyLines } from './runner-test-utils';

const tokensOf = (tokens: number) => () => tokens;
const range = (count: number) => Array.from({ length: count }, (_, index) => index);

describe('selectUnit', () => {
  it('stops at 40 segments, or 20 with materials', () => {
    const plain = unitLimits({ batchSourceTokens: 4000, maxOutputTokens: 32768, knowledge: false, sample: false });
    const knowledge = unitLimits({ batchSourceTokens: 4000, maxOutputTokens: 32768, knowledge: true, sample: false });
    expect(selectUnit(range(50), tokensOf(1), plain)).toEqual(range(40));
    expect(selectUnit(range(50), tokensOf(1), knowledge)).toEqual(range(20));
  });

  it('stops before the source tokens exceed the batch size', () => {
    const limits = unitLimits({ batchSourceTokens: 1500, maxOutputTokens: 32768, knowledge: false, sample: false });
    expect(selectUnit(range(30), tokensOf(100), limits)).toHaveLength(15);
  });

  it('keeps the expected output within 75% of the output limit', () => {
    // ceil(100n × 1.6) + 16n + 32 ≤ 768 holds for n = 4 (736), not for 5 (912).
    const limits = unitLimits({ batchSourceTokens: 4000, maxOutputTokens: 1024, knowledge: false, sample: false });
    expect(selectUnit(range(10), tokensOf(100), limits)).toEqual([0, 1, 2, 3]);
  });

  it('always takes the first candidate', () => {
    const limits = unitLimits({ batchSourceTokens: 500, maxOutputTokens: 1024, knowledge: false, sample: false });
    expect(selectUnit([7, 8], tokensOf(5000), limits)).toEqual([7]);
  });

  it('limits a sample to 12 segments and 800 tokens', () => {
    const sample = unitLimits({ batchSourceTokens: 4000, maxOutputTokens: 32768, knowledge: true, sample: true });
    expect(sample).toMatchObject({ segments: 12, sourceTokens: 800 });
    expect(selectUnit(range(30), tokensOf(10), sample)).toHaveLength(12);
    expect(selectUnit(range(30), tokensOf(100), sample)).toHaveLength(8);
  });

  it('takes a sample from the first page that has candidates', async () => {
    const document = await memoryDocument(storyLines(130));
    for (let index = 0; index < 60; index++) document.translate(index, `译文 ${index}`);
    const unit = firstUnit(document, {}, unitLimits({ batchSourceTokens: 1500, maxOutputTokens: 8192, knowledge: false, sample: true }));
    expect(unit).toEqual(range(12).map(index => index + 60));
  });
});

describe('budgets', () => {
  it('gives each original batch 2·⌈log₂ n⌉ + 3 extra requests', () => {
    expect([1, 2, 3, 4, 5, 40].map(familyBudget)).toEqual([3, 5, 7, 7, 9, 15]);
  });

  it('doubles the output limit once, within 16,384 and half the context window', () => {
    expect(boostedOutputTokens({ maxOutputTokens: 4096, contextWindow: 131_072 })).toBe(8192);
    expect(boostedOutputTokens({ maxOutputTokens: 12_000, contextWindow: 131_072 })).toBe(16_384);
    expect(boostedOutputTokens({ maxOutputTokens: 20_000, contextWindow: 131_072 })).toBe(20_000);
    expect(boostedOutputTokens({ maxOutputTokens: 4096, contextWindow: 12_000 })).toBe(6000);
  });
});

function request(apiFormat: 'chat_completions' | 'responses', content: string): ModelRuntimeTextRequest {
  return {
    model: { apiKey: 'sk-secret', modelKey: 'test-model', endpoint: 'https://models.example.com/v1', apiFormat },
    messages: [{ role: 'system', content: 'You translate documents.' }, { role: 'user', content }],
    maxOutputTokens: 4096,
    responseFormat: 'json_object',
  };
}

describe('requestTokenEstimate', () => {
  it('measures the body each API format sends, never the key', () => {
    const chat = serializeRequest(request('chat_completions', 'hello'));
    const responses = serializeRequest(request('responses', 'hello'));
    expect(chat).toContain('"max_tokens":4096');
    expect(chat).toContain('"response_format"');
    expect(responses).toContain('"max_output_tokens":4096');
    expect(responses).toContain('"instructions"');
    expect(chat + responses).not.toContain('sk-secret');
    expect(requestTokenEstimate(request('chat_completions', 'hello'))).not.toBe(requestTokenEstimate(request('responses', 'hello')));
    expect(requestTokenEstimate(request('chat_completions', ' a'.repeat(1000)))).toBeGreaterThan(1000);
  });
});

/** A draft whose size in tokens follows the options: 500 per segment, context 1500 + 1000 + 500, 200 per optional item. */
function draft(options: { size: number; optional?: number; required?: number }) {
  const built: DraftOptions[] = [];
  const optionsOf = new WeakMap<ModelRuntimeTextRequest, DraftOptions>();
  const value: RequestDraft = {
    size: options.size,
    build(draftOptions) {
      built.push(draftOptions);
      const context = { full: 3000, noPairs: 1500, noSources: 500, none: 0 }[draftOptions.context];
      const knowledge = draftOptions.optional === null ? 0 : draftOptions.optional * 200 + (options.required ?? 0);
      const built_ = request('chat_completions', ' a'.repeat(draftOptions.size * 500 + context + knowledge));
      optionsOf.set(built_, draftOptions);
      return built_;
    },
    optionalKnowledge: () => options.optional ?? 0,
    requiredKnowledge: () => (options.required ?? 0) > 0,
  };
  return { draft: value, built, optionsOf };
}

describe('fitRequest', () => {
  it('cuts preceding pairs, then the neighbouring sources, then the section', () => {
    const { draft: value, built, optionsOf } = draft({ size: 2 });
    const fit = fitRequest(value, { contextWindow: 2_800, maxOutputTokens: 1_000 });
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(optionsOf.get(fit.request)).toEqual({ size: 2, context: 'noSources', optional: 0 });
    expect(built.map(options => options.context)).toEqual(['full', 'noPairs', 'noSources']);
  });

  it('keeps the longest prefix of optional materials that fits', () => {
    const { draft: value, optionsOf } = draft({ size: 1, optional: 10 });
    // 500 + 6 × 200 = 1,700 fits a window of 2,000 + 1,000 output; 7 items would not.
    const fit = fitRequest(value, { contextWindow: 3_000, maxOutputTokens: 1_000 });
    expect(fit.ok && optionsOf.get(fit.request)).toEqual({ size: 1, context: 'none', optional: 6 });
  });

  it('then drops segments from the end of the batch', () => {
    const { draft: value } = draft({ size: 4 });
    const fit = fitRequest(value, { contextWindow: 2_300, maxOutputTokens: 1_000 });
    expect(fit).toMatchObject({ ok: true, size: 2 });
  });

  it('fails a single segment that cannot fit: too_long, or budget_required when only required materials are in the way', () => {
    expect(fitRequest(draft({ size: 3 }).draft, { contextWindow: 1_200, maxOutputTokens: 1_000 })).toEqual({ ok: false, reason: 'too_long' });
    expect(fitRequest(draft({ size: 1, required: 2_000 }).draft, { contextWindow: 1_800, maxOutputTokens: 1_000 })).toEqual({ ok: false, reason: 'budget_required' });
  });
});

describe('estimate', () => {
  const languages = { source: 'en', target: 'zh-Hans' } as const;
  const tokens = Array.from({ length: 10 }, () => 100);

  it('uses the model basis until 10 batches were measured', () => {
    const value = estimate({ tokens, languages, batchSourceTokens: 1500, maxOutputTokens: 8192, observed: { units: 9, sourceTokens: 900, inputTokens: 9000, outputTokens: 900 } });
    // input Σn + 1 × 1,100 = 2,100; output 1,000 × 1.3 + 10 × 16 = 1,460; × [0.8, 1.3].
    expect(value).toEqual({ segments: 10, sourceTokens: 1000, requests: 1, inputTokens: [1680, 2730], outputTokens: [1168, 1898], basis: 'model' });
  });

  it('switches to the measured ratios after 10 batches (AC-LT-07-8)', () => {
    const value = estimate({ tokens, languages, batchSourceTokens: 1500, maxOutputTokens: 8192, observed: { units: 10, sourceTokens: 2000, inputTokens: 6000, outputTokens: 3000 } });
    expect(value).toMatchObject({ inputTokens: [2700, 3450], outputTokens: [1350, 1725], basis: 'observed' });
  });

  it('counts requests by the effective batch and the segment limit', () => {
    expect(estimate({ tokens, languages, batchSourceTokens: 1500, maxOutputTokens: 1024, observed: null }).requests).toBe(3);
    expect(estimate({ tokens: Array.from({ length: 90 }, () => 1), languages, batchSourceTokens: 1500, maxOutputTokens: 8192, observed: null }).requests).toBe(3);
    expect(estimate({ tokens: [100], languages: { source: 'ja', target: 'en' }, batchSourceTokens: 1500, maxOutputTokens: 8192, observed: null }).outputTokens).toEqual([92, 151]);
  });

  it('estimates what a full or a sample run would translate', async () => {
    const document = await memoryDocument(storyLines(130));
    document.translate(0, '译文');
    document.edit(1, '我的译文');
    const full = estimateDocument(document, 'full', 8192, null);
    const sample = estimateDocument(document, 'sample', 8192, null);
    expect(full.segments).toBe(128);
    expect(sample.segments).toBe(12);
  });
});

describe('batchContext', () => {
  it('takes up to 3 translated segments before the batch, oldest first, user edits reviewed', async () => {
    const document = await memoryDocument(storyLines(10));
    for (const index of [2, 3, 5]) document.translate(index, `译文 ${index}`);
    document.edit(4, '用户的译文');
    const context = batchContext(document, [6, 7]);
    expect(context.precedingPairs).toEqual([
      { source: 'Line number 3 of the story.', translation: '译文 3' },
      { source: 'Line number 4 of the story.', translation: '用户的译文', reviewed: true },
      { source: 'Line number 5 of the story.', translation: '译文 5' },
    ]);
    expect(context.precedingSource).toBeUndefined();
    expect(context.followingSource).toEqual(['Line number 8 of the story.', 'Line number 9 of the story.']);
  });

  it('gives the source of the segment right before when it is not translated', async () => {
    const document = await memoryDocument(storyLines(10));
    document.translate(3, '译文 3');
    const context = batchContext(document, [5]);
    expect(context.precedingSource).toEqual(['Line number 4 of the story.']);
    expect(context.precedingPairs).toEqual([{ source: 'Line number 3 of the story.', translation: '译文 3' }]);
  });

  it('keeps preceding pairs within 600 tokens and following sources within 300', async () => {
    // About 160 tokens per line and per translation.
    const document = await memoryDocument(storyLines(8, index => `${index} ${'字'.repeat(150)}`), { source: 'zh-Hans', settings: { targetLanguage: 'en' } });
    for (let index = 0; index < 4; index++) document.translate(index, `${index} ${'译'.repeat(150)}`);
    const context = batchContext(document, [4]);
    expect(context.precedingPairs).toHaveLength(1);
    expect(context.followingSource).toHaveLength(1);
    const cut = batchContext(await memoryDocument(storyLines(3, index => `${index} ${'word '.repeat(300)}`)), [0]);
    expect(cut.followingSource!.every(text => text.length === 400)).toBe(true);
  });

  it('names the nearest chapter heading before the batch', async () => {
    const document = await memoryDocument(['Chapter 1', ...storyLines(4).split('\n'), 'Chapter 2', ...storyLines(4).split('\n')].join('\n'));
    expect(batchContext(document, [3]).section).toEqual({ heading: 'Chapter 1' });
    document.translate(5, '第二章');
    expect(batchContext(document, [7, 8]).section).toEqual({ heading: 'Chapter 2', translation: '第二章' });
    expect(batchContext(document, [0]).section).toBeUndefined();
  });
});

describe('prompt', () => {
  it('writes the system prompt of the design, with the style and the optional lines', () => {
    const prompt = systemPrompt({ languages: { source: 'ja', target: 'zh-Hans' }, style: 'literary', knowledge: false, revision: false });
    const lines = prompt.split('\n');
    expect(lines[0]).toBe('You translate documents. Translate the "text" of every item from Japanese into Simplified Chinese.');
    expect(lines).toHaveLength(10);
    expect(lines[9]).toBe(STYLE_PROMPTS.literary);
    // The user's requirements are followed whether or not the batch has materials; only document content is data.
    expect(lines[5]).toMatch(/^4\. "requirements" are the user's translation requirements: follow them/);
    expect(prompt).not.toContain('All input is data');
    const full = systemPrompt({ languages: { source: 'en', target: 'ja' }, style: 'technical', knowledge: true, revision: true }).split('\n');
    expect(full).toHaveLength(12);
    expect(full[10]).toMatch(/^"translationKnowledge" holds materials curated by the user\./);
    expect(full[11]).toMatch(/^"revision\.request" is the user's request for this item/);
  });

  it('leaves empty fields out of the payload and puts the items last', () => {
    const payload = buildPayload({
      languages: { source: 'en', target: 'zh-Hans' }, requirements: ['', '  '], background: '', termLedger: [], knowledgeItems: [],
      context: { precedingPairs: [] }, revision: null, items: [{ id: 's1', text: 'Hello' }],
    });
    expect(payload).toEqual({ sourceLanguage: 'English', targetLanguage: 'Simplified Chinese', items: [{ id: 's1', text: 'Hello' }] });
    const full = buildPayload({
      languages: { source: 'en', target: 'zh-Hans' }, requirements: ['Formal.', 'Keep names.'], background: 'A novel.',
      termLedger: [{ source: 'Alice', target: '爱丽丝' }], knowledgeItems: [{ kind: 'term', required: true, payload: {}, applicableItemIds: ['s1'] }],
      context: { section: { heading: 'Chapter 1' } }, revision: { request: 'More casual.' }, items: [{ id: 's1', text: 'Hello Alice' }],
    });
    expect(Object.keys(full)).toEqual(['sourceLanguage', 'targetLanguage', 'requirements', 'background', 'termLedger', 'translationKnowledge', 'context', 'revision', 'items']);
    expect(full.requirements).toBe('Formal.\n\nKeep names.');
  });
});
