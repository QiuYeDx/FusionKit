/** The wire IDs are scoped to one immutable source fragment, not subtitle timestamps. */
export type SubtitleCue = { id: string; lines: string[] };
/** Preserve blank LRC lines without creating an empty checkpoint fragment. */
export function coalesceEmptyLrcFragments(fragments: string[]): string[] {
  const result: string[] = [];
  let leading: string | undefined;
  for (const fragment of fragments) {
    if (!fragment.trim()) {
      if (result.length) result[result.length - 1] += `\n${fragment}`;
      else leading = leading === undefined ? fragment : `${leading}\n${fragment}`;
    } else {
      result.push(leading === undefined ? fragment : `${leading}\n${fragment}`);
      leading = undefined;
    }
  }
  return result.length ? result : fragments;
}
export type SubtitleCueDocument = {
  format: "SRT" | "LRC";
  cues: SubtitleCue[];
  parts: Array<{ prefix: string[]; cueId?: string; original: string[] }>;
};

export class SubtitleCueProtocolError extends Error {
  constructor(reason: string) {
    super(`字幕结构校验失败：${reason}`);
    this.name = "SubtitleCueProtocolError";
  }
}
const fail = (reason: string): never => { throw new SubtitleCueProtocolError(reason); };
const srtTime = /^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/;
const lrcTag = /^\[(\d+):([0-5]\d)(?:[.:](\d{1,3}))?\]/;
const inlineTime = /<\d+:[0-5]\d(?:[.:]\d{1,3})?>/;

function srtMilliseconds(value: string): number {
  const match = srtTime.exec(value);
  if (!match) return fail("SRT 时间格式无效");
  const milliseconds = ((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4]);
  if (!Number.isSafeInteger(milliseconds)) return fail("SRT 时间超出有效范围");
  return milliseconds;
}

export function parseSubtitleCueDocument(content: string, format: "SRT" | "LRC"): SubtitleCueDocument {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const document: SubtitleCueDocument = { format, cues: [], parts: [] };
  const add = (prefix: string[], lines: string[]) => {
    if (!lines.some(line => line.trim())) {
      document.parts.push({ prefix, original: lines });
      return;
    }
    const id = `cue-${document.cues.length + 1}`;
    document.cues.push({ id, lines });
    document.parts.push({ prefix, original: lines, cueId: id });
  };
  if (format === "SRT") {
    if (!normalized.trim()) return document;
    for (const block of normalized.trim().split(/\n[ \t]*\n+/)) {
      const [index, timeline, ...lines] = block.split("\n");
      if (!/^\d+$/.test(index.trim()) || !timeline) return fail("SRT 缺少编号或时间轴");
      const match = /^(\S+)[ \t]+-->[ \t]+(\S+)(?:[ \t]+.*)?$/.exec(timeline.trim());
      if (!match || srtMilliseconds(match[2]) < srtMilliseconds(match[1])) return fail("SRT 时间轴无效");
      add([index, timeline], lines);
    }
  } else {
    for (const line of normalized.split("\n")) {
      if (!line.trim() || /^\s*\[[a-zA-Z][\w-]*:[^\]\n]*\]\s*$/.test(line)) {
        document.parts.push({ prefix: [], original: [line] });
        continue;
      }
      let remaining = line.trimStart();
      let prefix = line.slice(0, line.length - remaining.length);
      let tags = 0;
      for (let match = lrcTag.exec(remaining); match; match = lrcTag.exec(remaining)) {
        tags++;
        prefix += match[0];
        remaining = remaining.slice(match[0].length);
      }
      if (!tags) return fail("LRC 正文缺少有效时间标签");
      if (inlineTime.test(remaining)) return fail("暂不支持含内联词时间标签的增强型 LRC");
      add([prefix], [remaining]);
    }
  }
  return document;
}

function validateLine(line: unknown): asserts line is string {
  if (typeof line !== "string" || !line.trim()) return fail("译文行为空或类型无效");
  if (/[\r\n\u0000-\u001f\u007f\u2028\u2029]/.test(line) || line.includes("-->") ||
      /\[\d+:[0-5]\d(?:[.:]\d{1,3})?\]/.test(line) || inlineTime.test(line) ||
      /^\s*\[[a-zA-Z][\w-]*:/.test(line)) return fail("译文包含额外的行或时间/元数据标签");
}

function render(document: SubtitleCueDocument, translations: Map<string, string[]>, bilingual: boolean): string {
  return document.parts.map(part => {
    const translated = part.cueId ? translations.get(part.cueId)! : undefined;
    if (document.format === "SRT") {
      const lines = translated
        ? (bilingual ? part.original.flatMap((line, index) => [line, translated[index]]) : translated)
        : part.original;
      return [...part.prefix, ...lines].join("\n");
    }
    if (!part.cueId) return [...part.prefix, ...part.original].join("");
    const prefix = part.prefix[0];
    return bilingual
      ? `${prefix}${part.original[0]}\n${prefix}${translated![0]}`
      : `${prefix}${translated![0]}`;
  }).join(document.format === "SRT" ? "\n\n" : "\n");
}

export function renderSubtitleCueResponse(document: SubtitleCueDocument, content: string, bilingual: boolean): string {
  let json = content.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(json);
  if (fenced) json = fenced[1];
  let body: unknown;
  try { body = JSON.parse(json); } catch { return fail("模型未返回完整 JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !Array.isArray((body as {cues?: unknown}).cues)) return fail("响应必须仅包含 cues 数组");
  const entries = (body as { cues: unknown[] }).cues;
  if (entries.length !== document.cues.length) return fail("字幕条目数量不一致");
  const expected = new Map(document.cues.map(cue => [cue.id, cue]));
  const translations = new Map<string, string[]>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return fail("字幕条目无效");
    const { id, lines } = entry as {id?: unknown; lines?: unknown};
    if (Object.keys(entry).length !== 2 || typeof id !== "string" || !expected.has(id) || translations.has(id)) return fail("字幕 ID 缺失、重复或多余");
    if (!Array.isArray(lines) || lines.length !== expected.get(id)!.lines.length) return fail("字幕文本行数量不一致");
    for (const line of lines) validateLine(line);
    translations.set(id, lines as string[]);
  }
  return render(document, translations, bilingual);
}

/** A legacy checkpoint is trusted only if its rendered structure still matches the source. */
export function validateCommittedSubtitle(document: SubtitleCueDocument, content: string, bilingual: boolean): void {
  const output = parseSubtitleCueDocument(content, document.format);
  const expectedParts = document.parts;
  let cursor = 0;
  for (const source of expectedParts) {
    const current = output.parts[cursor++];
    if (!current || JSON.stringify(current.prefix) !== JSON.stringify(source.prefix)) return fail("已完成译文的编号或时间标签与原文不符");
    if (!source.cueId) {
      if (JSON.stringify(current.original) !== JSON.stringify(source.original)) return fail("已完成译文的元数据或空白行变化");
    } else if (document.format === "SRT") {
      if (current.original.length !== source.original.length * (bilingual ? 2 : 1)) return fail("已完成译文行数与原文不符");
      source.original.forEach((line, index) => {
        if (bilingual && current.original[index * 2] !== line) return fail("已完成双语原文发生变化");
        validateLine(current.original[index * (bilingual ? 2 : 1) + (bilingual ? 1 : 0)]);
      });
    } else {
      if (bilingual) {
        if (current.original[0] !== source.original[0]) return fail("已完成双语原文发生变化");
        const translation = output.parts[cursor++];
        if (!translation || JSON.stringify(translation.prefix) !== JSON.stringify(source.prefix)) return fail("已完成译文时间标签与原文不符");
        validateLine(translation.original[0]);
      } else validateLine(current.original[0]);
    }
  }
  if (cursor !== output.parts.length) return fail("已完成译文包含多余字幕");
}

export function subtitleWithoutTranslation(document: SubtitleCueDocument): string | undefined {
  return document.cues.length === 0 ? render(document, new Map(), false) : undefined;
}
