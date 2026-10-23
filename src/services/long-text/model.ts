import { inferContextWindowSize, inferMaxOutputTokens } from '@/constants/model';
import {
  LONG_TEXT_LIMITS,
  modelSchema,
  type Estimate,
  type LanguageTag,
  type LongTextModel,
  type LongTextSettings,
} from '@/long-text/contract';
import type { KnowledgeSelection } from '@/translation-knowledge/execution-contract';
import type { ModelProfile, TokenPricing } from '@/type/model';

/** What a run sends to the main process with each start or retranslation; the key lives only in memory. */
export type RunModel = { model: LongTextModel; apiKey: string; profile: ModelProfile; fellBack: boolean };
export type RunModelProblem = 'no_profile' | 'no_key' | 'invalid' | 'context_too_small';

/** Bounds of the answer limit when the document leaves it automatic. */
const AUTO_OUTPUT_TOKENS = { min: 1024, max: 8192 } as const;
const LABEL_CHARS = 200;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * The model a run uses: the document's profile, or the task model when the document follows it
 * (`profileId: null`) or its profile was deleted (`fellBack`).
 */
export function resolveRunModel(
  settings: Pick<LongTextSettings, 'profileId' | 'maxOutputTokens'>,
  profiles: readonly ModelProfile[],
  taskProfile: ModelProfile | null,
): RunModel | { problem: RunModelProblem } {
  const chosen = settings.profileId === null ? undefined : profiles.find(item => item.id === settings.profileId);
  const profile = chosen ?? taskProfile;
  if (!profile) return { problem: 'no_profile' };
  const apiKey = profile.apiKey.trim();
  if (!apiKey) return { problem: 'no_key' };
  const modelKey = profile.modelKey.trim();
  const endpoint = profile.baseUrl.trim();
  if (!modelKey || !endpoint) return { problem: 'invalid' };

  const contextWindow = Math.min(inferContextWindowSize(modelKey), LONG_TEXT_LIMITS.defaultContextCap);
  if (contextWindow < LONG_TEXT_LIMITS.minContextWindow) return { problem: 'context_too_small' };
  const preferredOutput = settings.maxOutputTokens
    ?? clamp(profile.maxOutputTokens ?? inferMaxOutputTokens(modelKey), AUTO_OUTPUT_TOKENS.min, AUTO_OUTPUT_TOKENS.max);
  // Same default as Studio's normalizeTranslationModel: DeepSeek chat models answer without thinking.
  const thinkingOff = profile.apiFormat === 'chat_completions' && modelKey.toLowerCase().startsWith('deepseek-');
  const model = modelSchema.safeParse({
    profileId: profile.id,
    label: profile.name.slice(0, LABEL_CHARS),
    modelKey,
    endpoint,
    apiFormat: profile.apiFormat,
    ...(profile.outputTokenParameter ? { outputTokenParameter: profile.outputTokenParameter } : {}),
    ...(thinkingOff ? { thinkingEnabled: false } : {}),
    contextWindow,
    maxOutputTokens: Math.min(preferredOutput, Math.floor(contextWindow / 2)),
  });
  if (!model.success) return { problem: 'invalid' };
  return { model: model.data, apiKey, profile, fellBack: settings.profileId !== null && !chosen };
}

/** Dollar cost of an estimate's lower and upper bound, or null when the profile has no prices. */
export function costRange(estimate: Pick<Estimate, 'inputTokens' | 'outputTokens'>, pricing: TokenPricing): [number, number] | null {
  const { inputTokensPerMillion: input, outputTokensPerMillion: output } = pricing;
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0 || input + output === 0) return null;
  const cost = (bound: 0 | 1) => (estimate.inputTokens[bound] * input + estimate.outputTokens[bound] * output) / 1_000_000;
  return [cost(0), cost(1)];
}

/** A materials draft without collections. Its empty source never reaches the main process: saving it yields `knowledge: null`. */
export function emptyMaterials(target: LanguageTag): KnowledgeSelection {
  return { version: 2, languagePair: { source: '', target }, collectionIds: [], disabledEntryIds: [] };
}
