const OPTION_KEYS = {
  "kind.term": "kind.term",
  "kind.context": "kind.context",
  "kind.expression": "kind.expression",
  "kind.memory": "kind.memory",
  "kind.rule": "kind.rule",
  "strength.preferred": "strength.preferred",
  "strength.required": "strength.required",
  "strength.keep_source": "strength.keep_source",
  "match.literal_phrase": "match.literal_phrase",
  "match.whole_term": "match.whole_term",
  "assertion.fact": "assertion.fact",
  "assertion.reported": "assertion.reported",
  "assertion.uncertain": "assertion.uncertain",
  "alignment.one_to_one": "alignment.one_to_one",
  "alignment.reviewed_segment": "alignment.reviewed_segment",
  "dimension.register": "dimension.register",
  "dimension.honorifics": "dimension.honorifics",
  "dimension.person_reference": "dimension.person_reference",
  "dimension.fidelity": "dimension.fidelity",
  "dimension.other": "dimension.other",
  "role.topic": "role.topic",
  "role.speaker": "role.speaker",
  "role.mentioned": "role.mentioned",
  "role.present": "role.present",
  "condition.none": "condition.none",
  "condition.advisory": "condition.advisory",
  "condition.requires_confirmation": "condition.requires_confirmation",
  "learning.off": "learning.off",
  "learning.save_reviewed": "learning.save_reviewed",
  "subject_kind.person": "subject_kind.person",
  "subject_kind.work": "subject_kind.work",
  "subject_kind.domain": "subject_kind.domain",
  "subject_kind.other": "subject_kind.other",
  "status.ready": "status.ready",
  "status.candidate": "status.candidate",
  "status.unconfirmed": "status.unconfirmed",
  "status.needs_review": "status.needs_review",
  "status.rejected": "status.rejected",
  "status.archived": "status.archived",
  "group.subjects": "group.subjects",
  "group.collections": "group.collections",
  "group.sources": "group.sources",
  "group.entries": "group.entries",
  "group.styles": "group.styles",
  "group.recipes": "group.recipes",
  "group.preferenceTemplates": "group.preferenceTemplates",
  "export.title": "export.title",
  "export.description": "export.description",
  "export.purpose": "export.purpose",
  "export.share": "export.share",
  "export.backup": "export.backup",
  "export.share_help": "export.share_help",
  "export.backup_help": "export.backup_help",
  "export.memories": "export.memories",
  "export.memories_help": "export.memories_help",
  "export.success": "export.success",
  "export.backup_memories": "export.backup_memories",
} as const;
export function optionKey(key: string) {
  return OPTION_KEYS[key as keyof typeof OPTION_KEYS] ?? "filters.none";
}

const PROTOCOL_KEYS = {
  "protocol.id": "protocol.id",
  "protocol.revision": "protocol.revision",
  "protocol.extensions": "protocol.extensions",
  "protocol.archived": "protocol.archived",
  "protocol.kind": "protocol.kind",
  "protocol.name": "protocol.name",
  "protocol.title": "protocol.title",
  "protocol.aliases": "protocol.aliases",
  "protocol.tags": "protocol.tags",
  "protocol.description": "protocol.description",
  "protocol.aboutSubjectIds": "protocol.aboutSubjectIds",
  "protocol.defaultLanguagePair": "protocol.defaultLanguagePair",
  "protocol.source": "protocol.source",
  "protocol.target": "protocol.target",
  "protocol.excerpt": "protocol.excerpt",
  "protocol.url": "protocol.url",
  "protocol.accessedAt": "protocol.accessedAt",
  "protocol.attribution": "protocol.attribution",
  "protocol.contentDigest": "protocol.contentDigest",
  "protocol.digestDescription": "protocol.digestDescription",
  "protocol.collectionId": "protocol.collectionId",
  "protocol.scope": "protocol.scope",
  "protocol.languagePair": "protocol.languagePair",
  "protocol.requiredSubjects": "protocol.requiredSubjects",
  "protocol.subjectId": "protocol.subjectId",
  "protocol.role": "protocol.role",
  "protocol.condition": "protocol.condition",
  "protocol.mode": "protocol.mode",
  "protocol.text": "protocol.text",
  "protocol.state": "protocol.state",
  "protocol.evidence": "protocol.evidence",
  "protocol.sourceId": "protocol.sourceId",
  "protocol.support": "protocol.support",
  "protocol.note": "protocol.note",
  "protocol.derivedFrom": "protocol.derivedFrom",
  "protocol.entryId": "protocol.entryId",
  "protocol.digest": "protocol.digest",
  "protocol.evidenceSourceId": "protocol.evidenceSourceId",
  "protocol.payload": "protocol.payload",
  "protocol.assertion": "protocol.assertion",
  "protocol.core": "protocol.core",
  "protocol.sense": "protocol.sense",
  "protocol.match": "protocol.match",
  "protocol.caseSensitive": "protocol.caseSensitive",
  "protocol.strength": "protocol.strength",
  "protocol.sourcePhrase": "protocol.sourcePhrase",
  "protocol.interpretation": "protocol.interpretation",
  "protocol.targetExamples": "protocol.targetExamples",
  "protocol.mustNotInventOccurrences": "protocol.mustNotInventOccurrences",
  "protocol.beforeSource": "protocol.beforeSource",
  "protocol.afterSource": "protocol.afterSource",
  "protocol.alignment": "protocol.alignment",
  "protocol.directReuseAllowed": "protocol.directReuseAllowed",
  "protocol.dimension": "protocol.dimension",
  "protocol.ruleEntryIds": "protocol.ruleEntryIds",
  "protocol.readCollectionIds": "protocol.readCollectionIds",
  "protocol.subjectSuggestions": "protocol.subjectSuggestions",
  "protocol.baseStyleId": "protocol.baseStyleId",
  "protocol.modifierStyleIds": "protocol.modifierStyleIds",
  "protocol.instructions": "protocol.instructions",
  "protocol.context": "protocol.context",
  "protocol.inheritGlobalPreferences": "protocol.inheritGlobalPreferences",
  "protocol.learningSuggestion": "protocol.learningSuggestion",
  "protocol.suggestedDestinationCollectionId":
    "protocol.suggestedDestinationCollectionId",
} as const;
export function protocolKey(key: string) {
  return (
    PROTOCOL_KEYS[key as keyof typeof PROTOCOL_KEYS] ?? "detail.other_field"
  );
}

const DIAGNOSTIC_KEYS = {
  "diagnostic.CONFLICT_REVIEW_REQUIRED": "diagnostic.CONFLICT_REVIEW_REQUIRED",
  "diagnostic.LANGUAGE_TAG": "diagnostic.LANGUAGE_TAG",
  "diagnostic.SPEAKER_NOT_PERSON": "diagnostic.SPEAKER_NOT_PERSON",
  "diagnostic.EXPRESSION_SPEAKER_REQUIRED":
    "diagnostic.EXPRESSION_SPEAKER_REQUIRED",
  "diagnostic.KEEP_SOURCE_TARGET": "diagnostic.KEEP_SOURCE_TARGET",
  "diagnostic.REQUIRED_ADVISORY": "diagnostic.REQUIRED_ADVISORY",
  "diagnostic.STYLE_LANGUAGE_MISMATCH": "diagnostic.STYLE_LANGUAGE_MISMATCH",
  "diagnostic.RECIPE_STYLE_LANGUAGE": "diagnostic.RECIPE_STYLE_LANGUAGE",
  "diagnostic.RECIPE_STYLE_COLLECTION": "diagnostic.RECIPE_STYLE_COLLECTION",
  "diagnostic.RECIPE_LEARNING_DESTINATION":
    "diagnostic.RECIPE_LEARNING_DESTINATION",
  "diagnostic.REFERENCE_MISSING": "diagnostic.REFERENCE_MISSING",
  "diagnostic.DERIVATION_REVISION_CHANGED":
    "diagnostic.DERIVATION_REVISION_CHANGED",
  "diagnostic.MEMORY_ALIGNMENT_REVIEW": "diagnostic.MEMORY_ALIGNMENT_REVIEW",
  "diagnostic.AI_PROPOSAL_READY": "diagnostic.AI_PROPOSAL_READY",
  "diagnostic.STYLE_NOT_READY": "diagnostic.STYLE_NOT_READY",
  "diagnostic.RECIPE_STYLE_ARCHIVED": "diagnostic.RECIPE_STYLE_ARCHIVED",
  "diagnostic.TERM_TRANSLATION_CONFLICT":
    "diagnostic.TERM_TRANSLATION_CONFLICT",
} as const;
export function diagnosticKey(key: string) {
  return (
    DIAGNOSTIC_KEYS[key as keyof typeof DIAGNOSTIC_KEYS] ??
    "import.warning_generic"
  );
}

export type FieldName =
  | "kind"
  | "subject"
  | "collection"
  | "collections"
  | "language"
  | "status"
  | "source_text"
  | "target_text"
  | "sense"
  | "strength"
  | "match"
  | "case_sensitive"
  | "aliases_lines"
  | "context_text"
  | "assertion"
  | "core"
  | "source_phrase"
  | "interpretation"
  | "examples_lines"
  | "before_source"
  | "after_source"
  | "alignment"
  | "rule_text"
  | "dimension"
  | "source_language"
  | "target_language"
  | "about_subjects"
  | "subject_role"
  | "condition"
  | "condition_text"
  | "title_optional"
  | "source_note"
  | "name"
  | "description"
  | "subject_kind"
  | "tags_lines"
  | "rules"
  | "base_style"
  | "modifier_styles"
  | "instructions"
  | "content_context"
  | "subject_suggestions"
  | "inherit_preferences"
  | "learning"
  | "destination";
