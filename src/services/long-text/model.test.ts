import { describe, expect, it, vi } from 'vitest';
import { knowledgeSelectionSchema } from '@/translation-knowledge/execution-contract';
import { modelSchema } from '@/long-text/contract';
import { Model, type ModelProfile } from '@/type/model';
import { costRange, emptyMaterials, resolveRunModel, type RunModel } from './model';

vi.mock('@/constants/model', async importOriginal => {
  const actual = await importOriginal<typeof import('@/constants/model')>();
  const windows: Record<string, number> = { 'tiny-model': 4096, 'small-model': 10_000 };
  return { ...actual, inferContextWindowSize: (modelKey: string) => windows[modelKey] ?? actual.inferContextWindowSize(modelKey) };
});

const profile = (patch: Partial<ModelProfile> = {}): ModelProfile => ({
  id: 'task', name: 'DeepSeek V4', provider: Model.DeepSeek, apiKey: 'sk-task',
  baseUrl: 'https://api.deepseek.com', modelKey: 'deepseek-v4-flash', apiFormat: 'chat_completions',
  tokenPricing: { inputTokensPerMillion: 0.14, outputTokensPerMillion: 0.28 },
  ...patch,
});
const follow = { profileId: null, maxOutputTokens: null };

function resolved(result: ReturnType<typeof resolveRunModel>): RunModel {
  if ('problem' in result) throw new Error(`unexpected problem ${result.problem}`);
  return result;
}

describe('resolveRunModel', () => {
  it('follows the task model and builds a model the contract accepts', () => {
    const task = profile();
    const run = resolved(resolveRunModel(follow, [task], task));
    expect(run).toMatchObject({ apiKey: 'sk-task', profile: task, fellBack: false });
    expect(run.model).toEqual({
      profileId: 'task', label: 'DeepSeek V4', modelKey: 'deepseek-v4-flash', endpoint: 'https://api.deepseek.com',
      apiFormat: 'chat_completions', thinkingEnabled: false, contextWindow: 131_072, maxOutputTokens: 8192,
    });
    expect(modelSchema.safeParse(run.model).success).toBe(true);
  });

  it('uses the document profile when it exists', () => {
    const chosen = profile({ id: 'doc', name: 'GPT', apiKey: ' sk-doc ', baseUrl: 'https://api.openai.com/v1', modelKey: ' gpt-5.4-mini ',
      apiFormat: 'responses', outputTokenParameter: 'max_completion_tokens' });
    const run = resolved(resolveRunModel({ profileId: 'doc', maxOutputTokens: null }, [profile(), chosen], profile()));
    expect(run).toMatchObject({ apiKey: 'sk-doc', profile: chosen, fellBack: false });
    expect(run.model).toMatchObject({ profileId: 'doc', label: 'GPT', modelKey: 'gpt-5.4-mini', apiFormat: 'responses', outputTokenParameter: 'max_completion_tokens' });
    expect(run.model).not.toHaveProperty('thinkingEnabled');
  });

  it('falls back to the task model when the document profile was deleted', () => {
    const run = resolved(resolveRunModel({ profileId: 'deleted', maxOutputTokens: null }, [profile()], profile()));
    expect(run.fellBack).toBe(true);
    expect(run.model.profileId).toBe('task');
  });

  it('reports the problem that keeps a run from starting', () => {
    expect(resolveRunModel(follow, [], null)).toEqual({ problem: 'no_profile' });
    expect(resolveRunModel({ profileId: 'deleted', maxOutputTokens: null }, [profile()], null)).toEqual({ problem: 'no_profile' });
    expect(resolveRunModel(follow, [], profile({ apiKey: '  ' }))).toEqual({ problem: 'no_key' });
    expect(resolveRunModel(follow, [], profile({ baseUrl: '' }))).toEqual({ problem: 'invalid' });
    expect(resolveRunModel(follow, [], profile({ modelKey: ' ' }))).toEqual({ problem: 'invalid' });
    expect(resolveRunModel(follow, [], profile({ baseUrl: 'https://user:secret@api.example.com' }))).toEqual({ problem: 'invalid' });
    expect(resolveRunModel(follow, [], profile({ baseUrl: 'ftp://api.example.com' }))).toEqual({ problem: 'invalid' });
    expect(resolveRunModel(follow, [], profile({ modelKey: 'tiny-model' }))).toEqual({ problem: 'context_too_small' });
  });

  it('does not replace a broken document profile with the task model', () => {
    const broken = profile({ id: 'doc', apiKey: '' });
    expect(resolveRunModel({ profileId: 'doc', maxOutputTokens: null }, [broken], profile())).toEqual({ problem: 'no_key' });
  });

  it('turns thinking off only for DeepSeek chat completions', () => {
    expect(resolved(resolveRunModel(follow, [], profile({ modelKey: 'DeepSeek-V4-Pro' }))).model.thinkingEnabled).toBe(false);
    expect(resolved(resolveRunModel(follow, [], profile({ apiFormat: 'responses' }))).model).not.toHaveProperty('thinkingEnabled');
    expect(resolved(resolveRunModel(follow, [], profile({ modelKey: 'qwen-max' }))).model).not.toHaveProperty('thinkingEnabled');
  });

  it('keeps the answer limit at most half the context window', () => {
    // gpt-3.5 has a 16,385-token window: an explicit 32,768 becomes 8,192.
    expect(resolved(resolveRunModel({ profileId: null, maxOutputTokens: 32_768 }, [], profile({ modelKey: 'gpt-3.5-turbo' }))).model)
      .toMatchObject({ contextWindow: 16_385, maxOutputTokens: 8192 });
    expect(resolved(resolveRunModel(follow, [], profile({ modelKey: 'small-model' }))).model)
      .toMatchObject({ contextWindow: 10_000, maxOutputTokens: 5000 });
  });

  it('clamps the automatic answer limit and honours an explicit one', () => {
    const limit = (patch: Partial<ModelProfile>, maxOutputTokens: number | null = null) =>
      resolved(resolveRunModel({ profileId: null, maxOutputTokens }, [], profile(patch))).model.maxOutputTokens;
    expect(limit({ maxOutputTokens: 512 })).toBe(1024);
    expect(limit({ maxOutputTokens: 4000 })).toBe(4000);
    expect(limit({ modelKey: 'gpt-5.4' })).toBe(8192);
    expect(limit({ modelKey: 'gpt-3.5-turbo' })).toBe(4096);
    expect(limit({}, 16_000)).toBe(16_000);
  });
});

describe('costRange', () => {
  const estimate = { inputTokens: [1_000_000, 2_000_000] as [number, number], outputTokens: [500_000, 1_000_000] as [number, number] };

  it('prices both bounds per million tokens', () => {
    const [low, high] = costRange(estimate, { inputTokensPerMillion: 0.14, outputTokensPerMillion: 0.28 })!;
    expect(low).toBeCloseTo(0.28);
    expect(high).toBeCloseTo(0.56);
  });

  it('is null without prices', () => {
    expect(costRange(estimate, { inputTokensPerMillion: 0, outputTokensPerMillion: 0 })).toBeNull();
    expect(costRange(estimate, { inputTokensPerMillion: Number.NaN, outputTokensPerMillion: 1 })).toBeNull();
    expect(costRange(estimate, { inputTokensPerMillion: 0, outputTokensPerMillion: 2 })).toEqual([1, 2]);
  });
});

describe('emptyMaterials', () => {
  it('has no collections and an unset source', () => {
    expect(emptyMaterials('ja')).toEqual({ version: 2, languagePair: { source: '', target: 'ja' }, collectionIds: [], disabledEntryIds: [] });
  });

  it('becomes a valid selection once the page sets the source', () => {
    const draft = emptyMaterials('zh-Hans');
    expect(knowledgeSelectionSchema.safeParse(draft).success).toBe(false);
    expect(knowledgeSelectionSchema.safeParse({ ...draft, languagePair: { source: 'en', target: 'zh-Hans' } }).success).toBe(true);
  });
});
