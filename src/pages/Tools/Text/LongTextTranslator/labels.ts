import type {
  FlagCode,
  ImportSkipReason,
  LedgerEntry,
  LongTextErrorCode,
  LongTextRequest,
  Pace,
  QueryFilter,
  RepairKind,
  RunStatus,
  SegmentFailureCode,
  SegmentRow,
  Style,
  SupportedEncoding,
  TxtSplit,
  VerbatimKind,
} from "@/long-text/contract";
import type { RunModelProblem } from "@/services/long-text/model";

// Code → message key maps for the `text` namespace (`useTranslation("text")`). Every map covers its
// whole code union, so `t(MAP[code])` with a typed code resolves to a finite key set that
// check-i18n-usage verifies without manifest entries. Language names live in `labelKey` (languages.ts).

export const ERROR_LABELS = {
  invalid_request: "errors.invalid_request",
  unavailable: "errors.unavailable",
  not_found: "errors.not_found",
  busy: "errors.busy",
  conflict: "errors.conflict",
  revision_conflict: "errors.revision_conflict",
  file_unreadable: "errors.file_unreadable",
  file_too_large: "errors.file_too_large",
  unsupported_format: "errors.unsupported_format",
  subtitle_file: "errors.subtitle_file",
  empty_document: "errors.empty_document",
  binary_file: "errors.binary_file",
  too_many_segments: "errors.too_many_segments",
  encoding_unconfirmed: "errors.encoding_unconfirmed",
  source_missing: "errors.source_missing",
  source_changed: "errors.source_changed",
  translations_exist: "errors.translations_exist",
  same_language: "errors.same_language",
  nothing_to_do: "errors.nothing_to_do",
  model_invalid: "errors.model_invalid",
  model_context_too_small: "errors.model_context_too_small",
  model_failed: "errors.model_failed",
  unstable_output: "errors.unstable_output",
  knowledge_unavailable: "errors.knowledge_unavailable",
  knowledge_invalid: "errors.knowledge_invalid",
  storage_failed: "errors.storage_failed",
  destination_unavailable: "errors.destination_unavailable",
  export_failed: "errors.export_failed",
  name_exhausted: "errors.name_exhausted",
  limit_exceeded: "errors.limit_exceeded",
  internal: "errors.internal",
} as const satisfies Record<LongTextErrorCode, string>;

/** Why the document's model can't run (`resolveRunModel`); shown under the model field and as the disabled run buttons' tooltip. */
export const MODEL_PROBLEM_LABELS = {
  no_profile: "run.no_model",
  no_key: "settings.model_missing_key",
  invalid: "settings.model_invalid",
  context_too_small: "errors.model_context_too_small",
} as const satisfies Record<RunModelProblem, string>;

/** Why an import skipped a file; shown after the file name. */
export const IMPORT_SKIP_LABELS = {
  unsupported_format: "import.reason.unsupported_format",
  subtitle_file: "import.reason.subtitle_file",
  file_too_large: "import.reason.file_too_large",
  empty_document: "import.reason.empty_document",
  binary_file: "import.reason.binary_file",
  file_unreadable: "import.reason.file_unreadable",
  too_many_segments: "import.reason.too_many_segments",
  limit_exceeded: "import.reason.limit_exceeded",
} as const satisfies Record<ImportSkipReason, string>;

/**
 * Quality flags. Values: `ratio` (length_*), `source` / `target` (term_missing; use
 * `flags.term_missing_more` with `count` when `detail.more > 0`), `kinds` (joined
 * `REPAIR_KIND_LABELS`), `items` (markup_missing).
 */
export const FLAG_LABELS = {
  length_short: "flags.length_short",
  length_long: "flags.length_long",
  untranslated: "flags.untranslated",
  term_missing: "flags.term_missing",
  placeholder_repaired: "flags.placeholder_repaired",
  markup_missing: "flags.markup_missing",
} as const satisfies Record<FlagCode, string>;

export const REPAIR_KIND_LABELS = {
  code: "flags.kinds.code",
  url: "flags.kinds.url",
  html: "flags.kinds.html",
  math: "flags.kinds.math",
  format: "flags.kinds.format",
  link: "flags.kinds.link",
  table: "flags.kinds.table",
  other: "flags.kinds.other",
} as const satisfies Record<RepairKind, string>;

export const FAILURE_LABELS = {
  protocol_invalid: "failure.protocol_invalid",
  too_long: "failure.too_long",
  content_filtered: "failure.content_filtered",
  transport: "failure.transport",
  budget_required: "failure.budget_required",
  empty_output: "failure.empty_output",
} as const satisfies Record<SegmentFailureCode, string>;

/** Status word inside a row's accessible name (`reader.row_label`). */
export const ROW_STATUS_LABELS = {
  pending: "reader.row_status.pending",
  translating: "reader.row_status.translating",
  done: "reader.row_status.done",
  failed: "reader.row_status.failed",
} as const satisfies Record<SegmentRow["status"], string>;

/** Document-list status of the latest run (value: `percent`); a document without a run shows `library.status_new`. */
export const LIBRARY_STATUS_LABELS = {
  running: "library.status_running",
  pausing: "library.status_running",
  paused: "library.status_paused",
  completed: "library.status_done",
  failed: "library.status_failed",
  interrupted: "library.status_interrupted",
} as const satisfies Record<RunStatus, string>;

/**
 * Footer status line of a run. Values: `done` / `total`; `count` is the in-flight request count
 * while pausing and the translatable segment count once completed.
 */
export const RUN_STATUS_LABELS = {
  running: "status.running",
  pausing: "status.waiting",
  paused: "status.paused",
  completed: "status.completed",
  failed: "status.failed",
  interrupted: "status.interrupted",
} as const satisfies Record<RunStatus, string>;

export const ENCODING_LABELS = {
  "utf-8": "encoding.names.utf-8",
  "utf-16le": "encoding.names.utf-16le",
  "utf-16be": "encoding.names.utf-16be",
  gb18030: "encoding.names.gb18030",
  big5: "encoding.names.big5",
  shift_jis: "encoding.names.shift_jis",
  "euc-jp": "encoding.names.euc-jp",
  "euc-kr": "encoding.names.euc-kr",
  "windows-1252": "encoding.names.windows-1252",
} as const satisfies Record<SupportedEncoding, string>;

export const STYLE_LABELS = {
  general: "styles.general",
  literary: "styles.literary",
  technical: "styles.technical",
} as const satisfies Record<Style, string>;

export const PACE_LABELS = {
  1: "settings.pace_options.1",
  2: "settings.pace_options.2",
  4: "settings.pace_options.4",
} as const satisfies Record<Pace, string>;

/** `auto` takes `mode`: the label of the resolved split. */
export const TXT_SPLIT_LABELS = {
  auto: "settings.txt_split_auto",
  line: "settings.txt_split_line",
  unwrap: "settings.txt_split_unwrap",
} as const satisfies Record<TxtSplit, string>;

export const VERBATIM_LABELS = {
  code: "reader.verbatim.code",
  frontmatter: "reader.verbatim.frontmatter",
  html: "reader.verbatim.html",
  math: "reader.verbatim.math",
  rule: "reader.verbatim.rule",
  other: "reader.verbatim.other",
} as const satisfies Record<VerbatimKind, string>;

/** Reader filter tabs: the whole page plus every non-search query filter. */
export type ReaderFilter = "all" | Exclude<QueryFilter["kind"], "search">;

export const FILTER_LABELS = {
  all: "filter.all",
  attention: "filter.attention",
  untranslated: "filter.untranslated",
  edited: "filter.edited",
} as const satisfies Record<ReaderFilter, string>;

export const FILTER_EMPTY_LABELS = {
  attention: "filter.empty_attention",
  untranslated: "filter.empty_untranslated",
  edited: "filter.empty_edited",
} as const satisfies Record<Exclude<ReaderFilter, "all">, string>;

/** Quick requirements of the retranslate popover, in display order. */
export const RETRANSLATE_CHIPS = ["colloquial", "formal", "literal", "concise"] as const;
export type RetranslateChip = (typeof RETRANSLATE_CHIPS)[number];

export const RETRANSLATE_CHIP_LABELS = {
  colloquial: "retranslate.chips.colloquial",
  formal: "retranslate.chips.formal",
  literal: "retranslate.chips.literal",
  concise: "retranslate.chips.concise",
} as const satisfies Record<RetranslateChip, string>;

/** The sentence a chip writes into the requirement box. */
export const RETRANSLATE_CHIP_TEXTS = {
  colloquial: "retranslate.chip_text.colloquial",
  formal: "retranslate.chip_text.formal",
  literal: "retranslate.chip_text.literal",
  concise: "retranslate.chip_text.concise",
} as const satisfies Record<RetranslateChip, string>;

export const EXPORT_MODE_LABELS = {
  target: "export.target",
  bilingual: "export.bilingual",
} as const satisfies Record<LongTextRequest<"export">["mode"], string>;

export const LEDGER_ORIGIN_LABELS = {
  model: "ledger.origin_model",
  user: "ledger.origin_user",
} as const satisfies Record<LedgerEntry["origin"], string>;
