import type { TextTranslationGlossaryEntry } from "@/type/textTranslation";

export interface SemanticMemoryCharacter {
  sourceName: string;
  translatedName: string;
  aliases?: string[];
  description?: string;
  relationships?: string[];
  pronounOrGenderNotes?: string;
}

export interface SemanticMemoryTerminologyEntry {
  source: string;
  target: string;
  note?: string;
  origin: "user" | "model";
}

export interface SemanticMemory {
  schemaVersion: 1;
  version: number;
  updatedAfterSegmentId?: string;
  documentSummary: string;
  currentChapterSummary: string;
  currentSceneSummary: string;
  characters: SemanticMemoryCharacter[];
  terminology: SemanticMemoryTerminologyEntry[];
  styleRules: string[];
  unresolvedContext: string[];
  recentContinuityNotes: string[];
}

export interface CreateSemanticMemoryOptions {
  glossary?: TextTranslationGlossaryEntry[];
  documentBackground?: string;
  styleInstructions?: string;
}

export function createInitialSemanticMemory(
  options: CreateSemanticMemoryOptions = {},
): SemanticMemory {
  return {
    schemaVersion: 1,
    version: 0,
    documentSummary: options.documentBackground?.trim() ?? "",
    currentChapterSummary: "",
    currentSceneSummary: "",
    characters: [],
    terminology: (options.glossary ?? []).map((entry) => ({
      source: entry.source,
      target: entry.target,
      note: entry.note,
      origin: "user" as const,
    })),
    styleRules: options.styleInstructions?.trim()
      ? [options.styleInstructions.trim()]
      : [],
    unresolvedContext: [],
    recentContinuityNotes: [],
  };
}

export function cloneSemanticMemory(memory: SemanticMemory): SemanticMemory {
  return {
    ...memory,
    characters: memory.characters.map((character) => ({ ...character })),
    terminology: memory.terminology.map((entry) => ({ ...entry })),
    styleRules: [...memory.styleRules],
    unresolvedContext: [...memory.unresolvedContext],
    recentContinuityNotes: [...memory.recentContinuityNotes],
  };
}

export function normalizeSemanticMemory(memory: SemanticMemory): SemanticMemory {
  return {
    ...cloneSemanticMemory(memory),
    schemaVersion: 1,
    version: Math.max(0, Math.trunc(memory.version)),
  };
}
