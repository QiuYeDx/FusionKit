import { z } from "zod";
import {
  cloneSemanticMemory,
  type SemanticMemory,
  type SemanticMemoryCharacter,
  type SemanticMemoryTerminologyEntry,
} from "./semantic-memory";

const characterPatchSchema = z
  .object({
    sourceName: z.string().trim().min(1).max(200),
    translatedName: z.string().trim().min(1).max(200),
    aliases: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    description: z.string().trim().max(2_000).optional(),
    relationships: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
    pronounOrGenderNotes: z.string().trim().max(500).optional(),
  })
  .strict();

const terminologyPatchSchema = z
  .object({
    source: z.string().trim().min(1).max(300),
    target: z.string().trim().min(1).max(300),
    note: z.string().trim().max(1_000).optional(),
  })
  .strict();

export const semanticMemoryPatchSchema = z
  .object({
    documentSummary: z.string().trim().max(12_000).optional(),
    currentChapterSummary: z.string().trim().max(8_000).optional(),
    currentSceneSummary: z.string().trim().max(8_000).optional(),
    characterUpserts: z.array(characterPatchSchema).max(50).optional(),
    terminologyUpserts: z.array(terminologyPatchSchema).max(100).optional(),
    styleRulesToAdd: z.array(z.string().trim().min(1).max(1_000)).max(30).optional(),
    unresolvedContextToAdd: z
      .array(z.string().trim().min(1).max(1_000))
      .max(30)
      .optional(),
    unresolvedContextToResolve: z
      .array(z.string().trim().min(1).max(1_000))
      .max(30)
      .optional(),
    recentContinuityNotesToAdd: z
      .array(z.string().trim().min(1).max(1_000))
      .max(50)
      .optional(),
  })
  .strict();

export type SemanticMemoryPatch = z.infer<typeof semanticMemoryPatchSchema>;

export type SemanticMemoryWarningCode =
  | "invalid_memory_patch"
  | "user_terminology_conflict"
  | "compression_failed";

export interface SemanticMemoryWarning {
  code: SemanticMemoryWarningCode;
  message: string;
  source?: string;
  details?: Record<string, unknown>;
}

export interface ParseSemanticMemoryPatchResult {
  success: boolean;
  patch?: SemanticMemoryPatch;
  warning?: SemanticMemoryWarning;
}

export interface ApplySemanticMemoryPatchResult {
  memory: SemanticMemory;
  warnings: SemanticMemoryWarning[];
}

const MEMORY_ARRAY_LIMITS = {
  characters: 200,
  terminology: 500,
  styleRules: 120,
  unresolvedContext: 200,
  recentContinuityNotes: 200,
} as const;

export function parseSemanticMemoryPatch(
  input: string | unknown,
): ParseSemanticMemoryPatchResult {
  let parsed: unknown = input;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input.trim());
    } catch {
      return invalidPatchWarning("Memory patch is not valid JSON.", "invalid_json");
    }
  }

  const result = semanticMemoryPatchSchema.safeParse(parsed);
  if (!result.success) {
    return invalidPatchWarning(
      "Memory patch failed schema validation.",
      "schema_validation_failed",
    );
  }

  return {
    success: true,
    patch: result.data,
  };
}

export function applySemanticMemoryPatch(
  baseMemory: SemanticMemory,
  patch: SemanticMemoryPatch,
): ApplySemanticMemoryPatchResult {
  const memory = cloneSemanticMemory(baseMemory);
  const warnings: SemanticMemoryWarning[] = [];

  if (patch.documentSummary !== undefined) {
    memory.documentSummary = patch.documentSummary;
  }
  if (patch.currentChapterSummary !== undefined) {
    memory.currentChapterSummary = patch.currentChapterSummary;
  }
  if (patch.currentSceneSummary !== undefined) {
    memory.currentSceneSummary = patch.currentSceneSummary;
  }

  for (const character of patch.characterUpserts ?? []) {
    upsertCharacter(memory.characters, character);
  }

  for (const term of patch.terminologyUpserts ?? []) {
    upsertModelTerminology(memory.terminology, term, warnings);
  }

  appendUnique(memory.styleRules, patch.styleRulesToAdd ?? []);
  appendUnique(memory.unresolvedContext, patch.unresolvedContextToAdd ?? []);
  resolveUnresolvedContext(
    memory.unresolvedContext,
    patch.unresolvedContextToResolve ?? [],
  );
  appendUnique(
    memory.recentContinuityNotes,
    patch.recentContinuityNotesToAdd ?? [],
  );

  trimArrayFromStart(memory.characters, MEMORY_ARRAY_LIMITS.characters);
  trimArrayFromStart(memory.terminology, MEMORY_ARRAY_LIMITS.terminology);
  trimArrayFromStart(memory.styleRules, MEMORY_ARRAY_LIMITS.styleRules);
  trimArrayFromStart(
    memory.unresolvedContext,
    MEMORY_ARRAY_LIMITS.unresolvedContext,
  );
  trimArrayFromStart(
    memory.recentContinuityNotes,
    MEMORY_ARRAY_LIMITS.recentContinuityNotes,
  );

  return { memory, warnings };
}

export function createCompressionFailureFallbackMemory(
  memory: SemanticMemory,
): SemanticMemory {
  const fallback = cloneSemanticMemory(memory);
  const keepCount = Math.floor(fallback.recentContinuityNotes.length / 2);
  fallback.recentContinuityNotes =
    keepCount > 0 ? fallback.recentContinuityNotes.slice(-keepCount) : [];
  return fallback;
}

function invalidPatchWarning(
  message: string,
  reason: string,
): ParseSemanticMemoryPatchResult {
  return {
    success: false,
    warning: {
      code: "invalid_memory_patch",
      message,
      details: { reason },
    },
  };
}

function upsertCharacter(
  characters: SemanticMemoryCharacter[],
  character: SemanticMemoryCharacter,
): void {
  const existingIndex = characters.findIndex(
    (item) => normalizeKey(item.sourceName) === normalizeKey(character.sourceName),
  );
  const nextCharacter = {
    ...character,
    aliases: uniqueStrings(character.aliases ?? []),
    relationships: uniqueStrings(character.relationships ?? []),
  };

  if (existingIndex >= 0) {
    characters[existingIndex] = {
      ...characters[existingIndex],
      ...nextCharacter,
    };
    return;
  }

  characters.push(nextCharacter);
}

function upsertModelTerminology(
  terminology: SemanticMemoryTerminologyEntry[],
  term: Omit<SemanticMemoryTerminologyEntry, "origin">,
  warnings: SemanticMemoryWarning[],
): void {
  const sourceKey = normalizeKey(term.source);
  const userTerm = terminology.find(
    (entry) => entry.origin === "user" && normalizeKey(entry.source) === sourceKey,
  );
  if (userTerm) {
    if (userTerm.target !== term.target || userTerm.note !== term.note) {
      warnings.push({
        code: "user_terminology_conflict",
        source: term.source,
        message: "Model terminology conflicts with a user glossary entry.",
        details: {
          userTarget: userTerm.target,
          modelTarget: term.target,
        },
      });
    }
    return;
  }

  const modelTerm: SemanticMemoryTerminologyEntry = {
    ...term,
    origin: "model",
  };
  const existingIndex = terminology.findIndex(
    (entry) =>
      entry.origin === "model" && normalizeKey(entry.source) === sourceKey,
  );

  if (existingIndex >= 0) {
    terminology[existingIndex] = modelTerm;
    return;
  }

  terminology.push(modelTerm);
}

function appendUnique(target: string[], additions: string[]): void {
  const existing = new Set(target.map(normalizeKey));
  for (const value of additions) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = normalizeKey(trimmed);
    if (existing.has(key)) continue;
    target.push(trimmed);
    existing.add(key);
  }
}

function resolveUnresolvedContext(
  target: string[],
  resolvedItems: string[],
): void {
  if (resolvedItems.length === 0) return;
  const resolved = new Set(resolvedItems.map(normalizeKey));
  for (let index = target.length - 1; index >= 0; index -= 1) {
    if (resolved.has(normalizeKey(target[index]))) {
      target.splice(index, 1);
    }
  }
}

function trimArrayFromStart<T>(target: T[], limit: number): void {
  if (target.length <= limit) return;
  target.splice(0, target.length - limit);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}
