// ---------------------------------------------------------------------------
// Workflow templates: frequent jobs written once as a dependable prompt, with the
// parts that change (a folder, languages, formats) filled in by a small form.
// Each template has a prompt for FusionKit's own agent and, where the job can be
// done through FusionKit's MCP tools, one for an external agent (Claude Code,
// Codex, Cursor...) that writes the translations itself.
// ---------------------------------------------------------------------------

export type TemplateTarget = "fusionkit" | "external";
export type TemplateValue = string | boolean;
export type TemplateValues = Record<string, TemplateValue>;
type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface TemplateOption {
  value: string;
  labelKey: string;
}

export interface TemplateField {
  key: string;
  kind: "folder" | "toggle" | "select";
  labelKey: string;
  hintKey?: string;
  required?: boolean;
  defaultValue: TemplateValue;
  options?: readonly TemplateOption[];
  /** Shown only while another field has this value, or (not) any other. */
  when?: { key: string; value?: TemplateValue; not?: TemplateValue };
}

export type TemplateIcon = "media" | "convert" | "names" | "translate" | "extract" | "resume";
/** Names the template's `home:templates.<id>.*` texts. */
export type TemplateId = "media_bilingual" | "convert_subtitles" | "bilingual_names" | "translate_subtitles" | "extract_language" | "resume_translation";

export interface PromptTemplate {
  id: TemplateId;
  icon: TemplateIcon;
  fields: readonly TemplateField[];
  /** The agents this job can be given to. */
  targets: readonly TemplateTarget[];
  /** Tool pages where the template is offered first in the floating panel. */
  routes: readonly string[];
  build: (values: TemplateValues, target: TemplateTarget, t: Translate) => string;
}

/** Keeps a literal key literal, so the i18n usage check can resolve it. */
const K = <Key extends string>(key: Key): `home:templates.${Key}` => `home:templates.${key}`;

const LANGUAGES = ["ZH", "ZH_HANT", "JA", "EN", "KO"] as const;
const languageOptions = (codes: readonly string[]): TemplateOption[] => codes.map((value) => ({ value, labelKey: K(`lang.${value}`) }));
/** Speech language codes for start_studio_transcription. */
const SPOKEN_CODES: Record<string, string> = { auto: "auto", JA: "ja", EN: "en", ZH: "zh", KO: "ko" };
/** Language codes for extract_subtitle_language. */
const KEEP_CODES: Record<string, string> = { ZH: "zh", JA: "ja", EN: "en", KO: "ko" };

const folder: TemplateField = { key: "path", kind: "folder", labelKey: K("field.folder"), hintKey: K("field.folder_hint"), required: true, defaultValue: "" };
const recursive = (defaultValue: boolean): TemplateField => ({ key: "recursive", kind: "toggle", labelKey: K("field.recursive"), defaultValue });
const targetLanguage: TemplateField = { key: "target", kind: "select", labelKey: K("field.target"), defaultValue: "ZH", options: languageOptions(LANGUAGES) };

const text = (values: TemplateValues, key: string) => String(values[key] ?? "").trim();
const lang = (t: Translate, code: string) => t(K(`lang.${code}`));
/** The folder, or a marked gap while the form has none yet. */
const folderText = (t: Translate, values: TemplateValues) => text(values, "path") || t(K("text.folder_missing"));
const recursiveText = (t: Translate, values: TemplateValues) => t(K(values.recursive ? "text.recursive_yes" : "text.recursive_no"));
const join = (lines: (string | false | undefined)[]) => lines.filter((line): line is string => !!line).join("\n");

/** How a bilingual name reads, e.g. "Chinese name first, then the original, joined by " - "". */
function nameFormatText(t: Translate, values: TemplateValues): string {
  const target = lang(t, text(values, "target"));
  if (values.layout === "target_only") return t(K("text.name_target_only"), { target });
  return t(K(`text.name_${values.layout === "source_first" ? "source_first" : "target_first"}`), { target, separator: t(K(`separator.${text(values, "separator") || "dash"}`)) });
}

export const PROMPT_TEMPLATES: readonly PromptTemplate[] = [
  {
    id: "media_bilingual",
    icon: "media",
    targets: ["fusionkit", "external"],
    routes: ["/tools/subtitle/studio", "/tools/subtitle/local-transcriber"],
    fields: [
      folder,
      recursive(false),
      { key: "spoken", kind: "select", labelKey: K("field.spoken"), defaultValue: "auto",
        options: [{ value: "auto", labelKey: K("lang.auto") }, ...languageOptions(["JA", "EN", "ZH", "KO"])] },
      targetLanguage,
      { key: "layout", kind: "select", labelKey: K("field.subtitle_layout"), defaultValue: "target_first", options: [
        { value: "target_first", labelKey: K("layout.target_first") },
        { value: "source_first", labelKey: K("layout.source_first") },
        { value: "target_only", labelKey: K("layout.target_only") },
      ] },
      { key: "format", kind: "select", labelKey: K("field.format"), defaultValue: "auto", options: [
        { value: "auto", labelKey: K("format.auto") }, { value: "lrc", labelKey: K("format.lrc") }, { value: "srt", labelKey: K("format.srt") },
      ] },
      { key: "rename", kind: "toggle", labelKey: K("field.rename_after"), hintKey: K("field.rename_after_hint"), defaultValue: true },
    ],
    build: (values, target, t) => {
      const vars = {
        path: folderText(t, values), recursive: recursiveText(t, values), target: lang(t, text(values, "target")),
        spoken: values.spoken === "auto" ? t(K("lang.auto_spoken")) : lang(t, text(values, "spoken")),
        layout: t(K(`layout.${text(values, "layout")}`)), format: t(K(`format.${text(values, "format")}`)),
        name: nameFormatText(t, { ...values, layout: values.layout === "target_only" ? "target_first" : values.layout, separator: "dash" }),
        spokenCode: SPOKEN_CODES[text(values, "spoken")] ?? "auto",
        content: values.layout === "target_only" ? "target" : "bilingual",
        order: values.layout === "source_first" ? "source-first" : "target-first",
        formatCode: text(values, "format") || "auto", recursiveBool: String(!!values.recursive),
      };
      const prefix = target === "external" ? "media_bilingual.external" : "media_bilingual.fusionkit";
      return join([
        t(K(`${prefix}.intro`), vars),
        t(K(`${prefix}.step_transcribe`), vars),
        t(K(`${prefix}.step_translate`), vars),
        target === "external" && t(K(`${prefix}.step_export`), vars),
        values.rename && t(K(`${prefix}.step_rename`), vars),
        t(K("text.finish_rule")),
      ]);
    },
  },
  {
    id: "convert_subtitles",
    icon: "convert",
    targets: ["fusionkit", "external"],
    routes: ["/tools/subtitle/converter"],
    fields: [
      folder,
      recursive(true),
      { key: "to", kind: "select", labelKey: K("field.to_format"), defaultValue: "lrc", options: ["lrc", "srt", "vtt", "ass"].map((value) => ({ value, labelKey: K(`format.${value}`) })) },
      { key: "overwrite", kind: "toggle", labelKey: K("field.overwrite"), hintKey: K("field.overwrite_hint"), defaultValue: false },
    ],
    build: (values, target, t) => t(K(`convert_subtitles.${target}`), {
      path: folderText(t, values), recursive: recursiveText(t, values), to: text(values, "to").toUpperCase(), toCode: text(values, "to"),
      recursiveBool: String(!!values.recursive), conflict: values.overwrite ? "overwrite" : "indexed",
      overwrite: t(K(values.overwrite ? "text.overwrite_yes" : "text.overwrite_no")),
    }),
  },
  {
    id: "bilingual_names",
    icon: "names",
    targets: ["fusionkit", "external"],
    routes: ["/tools/rename/name-translator"],
    fields: [
      folder,
      recursive(true),
      { key: "kind", kind: "select", labelKey: K("field.name_kind"), defaultValue: "files", options: [
        { value: "files", labelKey: K("kind.files") }, { value: "directories", labelKey: K("kind.directories") }, { value: "both", labelKey: K("kind.both") },
      ] },
      targetLanguage,
      { key: "layout", kind: "select", labelKey: K("field.name_layout"), defaultValue: "target_first", options: [
        { value: "target_first", labelKey: K("name_layout.target_first") },
        { value: "source_first", labelKey: K("name_layout.source_first") },
        { value: "target_only", labelKey: K("name_layout.target_only") },
      ] },
      { key: "separator", kind: "select", labelKey: K("field.separator"), defaultValue: "dash", when: { key: "layout", not: "target_only" },
        options: ["dash", "paren", "bracket", "underscore", "space"].map((value) => ({ value, labelKey: K(`separator.${value}`) })) },
    ],
    build: (values, target, t) => t(K(`bilingual_names.${target}`), {
      path: folderText(t, values), recursive: recursiveText(t, values), kind: t(K(`kind.${text(values, "kind")}`)),
      target: lang(t, text(values, "target")), name: nameFormatText(t, values),
      includeChildren: t(K(values.recursive ? "text.children_all" : "text.children_top")),
    }),
  },
  {
    id: "translate_subtitles",
    icon: "translate",
    targets: ["fusionkit", "external"],
    routes: ["/tools/subtitle/translator"],
    fields: [
      folder,
      recursive(false),
      targetLanguage,
      { key: "layout", kind: "select", labelKey: K("field.subtitle_layout"), defaultValue: "target_first", options: [
        { value: "target_first", labelKey: K("layout.target_first") },
        { value: "source_first", labelKey: K("layout.source_first") },
        { value: "target_only", labelKey: K("layout.target_only") },
      ] },
    ],
    build: (values, target, t) => t(K(`translate_subtitles.${target}`), {
      path: folderText(t, values), recursive: recursiveText(t, values), target: lang(t, text(values, "target")),
      layout: t(K(`layout.${text(values, "layout")}`)), recursiveBool: String(!!values.recursive),
      content: values.layout === "target_only" ? "target" : "bilingual", order: values.layout === "source_first" ? "source-first" : "target-first",
    }),
  },
  {
    id: "extract_language",
    icon: "extract",
    targets: ["fusionkit", "external"],
    routes: ["/tools/subtitle/extractor"],
    fields: [
      folder,
      recursive(true),
      { key: "keep", kind: "select", labelKey: K("field.keep"), defaultValue: "ZH", options: languageOptions(["ZH", "JA", "EN", "KO"]) },
    ],
    build: (values, target, t) => t(K(`extract_language.${target}`), {
      path: folderText(t, values), recursive: recursiveText(t, values), keep: lang(t, text(values, "keep")),
      keepCode: KEEP_CODES[text(values, "keep")] ?? "zh", recursiveBool: String(!!values.recursive),
    }),
  },
  {
    id: "resume_translation",
    icon: "resume",
    targets: ["fusionkit"],
    routes: ["/tools/subtitle/translator"],
    fields: [folder],
    build: (values, _target, t) => t(K("resume_translation.fusionkit"), { path: folderText(t, values) }),
  },
];

export function findPromptTemplate(id: string): PromptTemplate | undefined {
  return PROMPT_TEMPLATES.find((template) => template.id === id);
}

export function templatesForRoute(pathname: string): PromptTemplate[] {
  return PROMPT_TEMPLATES.filter((template) => template.routes.some((route) => pathname === route || pathname.startsWith(`${route}/`)));
}

export function defaultTemplateValues(template: PromptTemplate): TemplateValues {
  return Object.fromEntries(template.fields.map((field) => [field.key, field.defaultValue]));
}

export function isFieldShown(field: TemplateField, values: TemplateValues): boolean {
  if (!field.when) return true;
  const value = values[field.when.key];
  return field.when.not !== undefined ? value !== field.when.not : value === field.when.value;
}

/** The required fields still empty; the prompt can only be used once there are none. */
export function missingTemplateFields(template: PromptTemplate, values: TemplateValues): string[] {
  return template.fields.filter((field) => field.required && isFieldShown(field, values) && !String(values[field.key] ?? "").trim()).map((field) => field.key);
}

// The values used last time, per template, so a repeated job is one click: the folder changes, the rest stays.
const VALUES_KEY = "fusionkit-prompt-template-values";

export function readTemplateValues(template: PromptTemplate): TemplateValues {
  const defaults = defaultTemplateValues(template);
  try {
    const saved = JSON.parse(localStorage.getItem(VALUES_KEY) ?? "{}")?.[template.id];
    if (!saved || typeof saved !== "object") return defaults;
    for (const field of template.fields) {
      const value = saved[field.key];
      const valid = field.kind === "toggle" ? typeof value === "boolean"
        : field.kind === "select" ? field.options?.some((option) => option.value === value)
        : typeof value === "string";
      if (valid) defaults[field.key] = value;
    }
  } catch { /* defaults then */ }
  return defaults;
}

export function writeTemplateValues(template: PromptTemplate, values: TemplateValues): void {
  try {
    const all = JSON.parse(localStorage.getItem(VALUES_KEY) ?? "{}") ?? {};
    all[template.id] = values;
    localStorage.setItem(VALUES_KEY, JSON.stringify(all));
  } catch { /* the values then last until the dialog closes */ }
}
