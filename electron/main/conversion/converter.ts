/**
 * 字幕格式转换模块 —— 纯字符串转换，不涉及文件系统或 Electron API。
 *
 * 支持 LRC / SRT / VTT / ASS / SSA / SBV 六种格式之间的任意互转。
 * 唯一对外暴露的入口是 convertSubtitle()：先把源文件解析为统一的 Cue 列表，
 * 再序列化为目标格式，新增格式只需补一对 parse / serialize 函数。
 *
 * 各格式的核心差异：
 *  - LRC：仅有开始时间 [mm:ss.xx]，无结束时间，精度为厘秒
 *  - SRT：有序号 + 开始/结束时间 HH:MM:SS,mmm（逗号分隔毫秒），精度为毫秒
 *  - VTT：类似 SRT 但以 "WEBVTT" 头部开头，时间戳用点分隔毫秒 HH:MM:SS.mmm
 *  - ASS / SSA：分节脚本，[Events] 中的 Dialogue 行带 H:MM:SS.cc（厘秒）时间与覆盖标签
 *  - SBV：YouTube 格式，"H:MM:SS.mmm,H:MM:SS.mmm" 一行时间后接纯文本
 *
 * 中间表示：Cue.text 使用 SRT 风格文本 —— "\n" 换行，<b>/<i>/<u> 表示样式，
 * 可能夹带 SRT 常见的 <font> 标签或 {\anN} 定位标签，由各序列化函数按目标格式取舍。
 */
import path from "path";
import { stripTrailingMediaExtension } from "../../../src/lib/media-file-name";
import { ASS_HEADER, SSA_HEADER } from "../../../src/subtitle-studio/formats/ass";

export type SubtitleConvertFormat = "LRC" | "SRT" | "VTT" | "ASS" | "SSA" | "SBV";

/** 转换输入参数 */
export type ConvertParams = {
  /** 原始文件名，用于推导输出文件名 */
  fileName: string;
  /** 原始字幕文件的文本内容 */
  fileContent: string;
  /** 源格式 */
  from: SubtitleConvertFormat;
  /** 目标格式 */
  to: SubtitleConvertFormat;
  /** LRC→其他格式时，为最后一条字幕补充的默认持续时长（毫秒），默认 2000 */
  defaultDurationMs?: number;
  /**
   * 是否剥离文件名中夹带的媒体扩展名。
   * 例如 "xxxname.wav.vtt" → 输出基础名变为 "xxxname"（去掉 .wav）。
   */
  stripMediaExt?: boolean;
};

/** 转换输出结果 */
export type ConvertResult = {
  /** 推导出的输出文件名（含新扩展名） */
  outputFileName: string;
  /** 转换后的字幕文本内容 */
  outputContent: string;
};

/** 统一的字幕条目；endMs 为 null 表示源格式没有结束时间（LRC） */
type Cue = { startMs: number; endMs: number | null; text: string };
type Mark = "b" | "i" | "u";

/** 每条字幕至少持续 300ms，避免闪现 */
const MIN_DURATION_MS = 300;

/**
 * 从原始文件名推导输出文件的基础名（不含扩展名）。
 *
 * 处理流程示例（stripMediaExt = true）：
 *   "song.wav.vtt"
 *   → 第一步去掉最外层扩展名 ".vtt" → "song.wav"
 *   → 第二步检测到 ".wav" 是媒体扩展名，继续剥离 → "song"
 *
 * @returns 基础名；极端情况下（如文件名就是 ".vtt"）回退为 "subtitle"
 */
function getOutputBaseName(fileName: string, stripMediaExt?: boolean): string {
  let base = path.parse(fileName).name;

  if (stripMediaExt) {
    base = stripTrailingMediaExtension(base);
  }

  return base || "subtitle";
}

/** 数字补零 */
function pad(n: number, width = 2): string {
  return n.toString().padStart(width, "0");
}

/** 统一换行符并去掉 BOM */
function normalizeContent(content: string): string {
  return content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/** 按空行切分为块，每块内的行去掉首尾空白并丢弃空行 */
function splitBlocks(content: string): string[][] {
  return normalizeContent(content)
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    )
    .filter((lines) => lines.length > 0);
}

/** 去掉每行首尾空白并丢弃空行（空行在 SRT / SBV 中是块分隔符） */
function cleanLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/** 小数部分 1~3 位统一换算为毫秒，如 "5" → 500、"05" → 50 */
function fractionToMs(frac: string | undefined): number {
  return frac ? parseInt(frac.padEnd(3, "0").slice(0, 3), 10) : 0;
}

/** [H:]MM:SS[.,]fff → 毫秒（SRT / VTT / SBV / ASS 共用，小时可选、分隔符宽松） */
const CLOCK = String.raw`(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?`;
function clockToMs(match: RegExpExecArray, offset: number): number {
  const hours = parseInt(match[offset] || "0", 10);
  const minutes = parseInt(match[offset + 1], 10);
  const seconds = parseInt(match[offset + 2], 10);
  return hours * 3600000 + minutes * 60000 + seconds * 1000 + fractionToMs(match[offset + 3]);
}

// ────────────────────────────────────────────────
//  文本标记处理
// ────────────────────────────────────────────────

/** 形如 HTML 的标签（要求紧跟字母或斜杠，避免把 "a < b" 误判为标签） */
const HTML_TAG = /<\/?[a-zA-Z][^<>]*>/g;
/** ASS 覆盖标签块 {\...} */
const ASS_BLOCK = /\{\\[^}]*\}/g;

/** 去掉全部标记，仅保留纯文本（LRC / SBV） */
function toPlainText(text: string): string {
  return text.replace(HTML_TAG, "").replace(ASS_BLOCK, "");
}

/** 仅保留 <b>/<i>/<u>，并按 VTT 规则转义 & < > */
function toVttText(text: string): string {
  return text
    .replace(ASS_BLOCK, "")
    .split(/(<\/?[a-zA-Z][^<>]*>)/)
    .map((part, index) => {
      if (index % 2 === 1) {
        const tag = /^<(\/?)([biu])>$/i.exec(part);
        return tag ? `<${tag[1]}${tag[2].toLowerCase()}>` : "";
      }
      return part.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    })
    .join("");
}

/** <b>/<i>/<u> → {\b1}/{\b0} 等覆盖标签，换行 → \N；其他 HTML 标签丢弃 */
function toAssText(text: string): string {
  return text
    .replace(/<(\/?)([biu])>/gi, (_, close: string, mark: string) => `{\\${mark.toLowerCase()}${close ? 0 : 1}}`)
    .replace(HTML_TAG, "")
    .replace(/\}\{/g, "")
    .replace(/\n/g, "\\N");
}

/** VTT 文本 → 中间表示：保留 <b>/<i>/<u>（去掉 class），丢弃其余标签并解码实体 */
function vttToInternal(text: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", nbsp: " ", lrm: "‎", rlm: "‏" };
  return text
    .split(/(<[^<>]*>)/)
    .map((part, index) => {
      if (index % 2 === 1) {
        const tag = /^<(\/?)([biu])(?:\.[^>\s]*)?>$/i.exec(part);
        return tag ? `<${tag[1]}${tag[2].toLowerCase()}>` : "";
      }
      return part.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, name: string) => {
        if (name[0] === "#") {
          const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
          return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
        }
        return entities[name.toLowerCase()] ?? entity;
      });
    })
    .join("");
}

/** 将带样式的文本片段序列化为正确嵌套的 <b>/<i>/<u> 标签 */
function marksToTags(segments: { text: string; marks: Mark[] }[]): string {
  let output = "";
  let open: Mark[] = [];
  for (const segment of segments) {
    let common = 0;
    while (common < open.length && common < segment.marks.length && open[common] === segment.marks[common]) common++;
    output += open.slice(common).reverse().map((mark) => `</${mark}>`).join("");
    output += segment.marks.slice(common).map((mark) => `<${mark}>`).join("");
    output += segment.text;
    open = segment.marks;
  }
  return output + [...open].reverse().map((mark) => `</${mark}>`).join("");
}

/**
 * ASS 事件文本 → 中间表示。
 *  - {\b1}/{\i1}/{\u1} 及其关闭、{\r} 重置 → <b>/<i>/<u>
 *  - {\p1} 绘图指令期间的内容丢弃
 *  - \N → 换行；\n、\h → 空格
 *  - 非默认的 {\anN} 对齐保留为前缀（SRT 播放器普遍支持），其余覆盖标签丢弃
 */
function assToInternal(text: string, baseMarks: Mark[], styles: Map<string, Mark[]>): string {
  const segments: { text: string; marks: Mark[] }[] = [];
  let active = new Set<Mark>(baseMarks);
  let drawing = false;
  let alignment: string | undefined;
  const push = (value: string) => {
    const marks = (["b", "i", "u"] as const).filter((mark) => active.has(mark));
    const last = segments[segments.length - 1];
    if (last && last.marks.join() === marks.join()) last.text += value;
    else segments.push({ text: value, marks });
  };

  for (let at = 0; at < text.length; ) {
    if (text[at] === "{") {
      const close = text.indexOf("}", at + 1);
      if (close > at) {
        for (const token of text.slice(at + 1, close).split("\\").slice(1)) {
          const style = /^([biu])(\d+)$/.exec(token);
          if (style) {
            if (parseInt(style[2], 10)) active.add(style[1] as Mark);
            else active.delete(style[1] as Mark);
            continue;
          }
          const reset = /^r(.*)$/.exec(token);
          if (reset) {
            active = new Set(styles.get(reset[1].trim()) ?? baseMarks);
            continue;
          }
          const draw = /^p(\d+)$/.exec(token);
          if (draw) drawing = parseInt(draw[1], 10) > 0;
          const align = /^an([1-9])$/.exec(token);
          if (align) alignment = align[1];
        }
        at = close + 1;
        continue;
      }
    }
    if (text[at] === "\\" && /[Nnh]/.test(text[at + 1] ?? "")) {
      if (!drawing) push(text[at + 1] === "N" ? "\n" : " ");
      at += 2;
      continue;
    }
    if (!drawing) push(text[at]);
    at++;
  }

  const body = cleanLines(marksToTags(segments));
  if (!toPlainText(body).trim()) return "";
  return alignment && alignment !== "2" ? `{\\an${alignment}}${body}` : body;
}

// ────────────────────────────────────────────────
//  解析：源格式 → Cue[]
// ────────────────────────────────────────────────

/**
 * LRC 解析。
 *
 * LRC 支持"多时间标签"语法，如 [00:01.00][00:05.00]歌词，表示同一段文字在
 * 多个时间点出现，解析时展开为多个条目；同一时刻的多行文本（如双语歌词）
 * 合并为一条多行字幕。[ar:]、[ti:] 等元数据行与增强 LRC 的 <mm:ss.xx> 逐字时间会被忽略。
 */
function parseLrc(content: string): Cue[] {
  const timeTag = /\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const timeToTexts = new Map<number, string[]>();

  for (const line of normalizeContent(content).split("\n")) {
    const tags = [...line.matchAll(timeTag)];
    if (tags.length === 0) continue;
    const text = line
      .replace(timeTag, "")
      .replace(/<\d+:\d{1,2}(?:[.:]\d{1,3})?>/g, "")
      .trim();
    if (!text) continue;
    for (const tag of tags) {
      const timeMs = parseInt(tag[1], 10) * 60000 + parseInt(tag[2], 10) * 1000 + fractionToMs(tag[3]);
      const texts = timeToTexts.get(timeMs) ?? [];
      if (!texts.includes(text)) texts.push(text);
      timeToTexts.set(timeMs, texts);
    }
  }

  return [...timeToTexts.keys()]
    .sort((a, b) => a - b)
    .map((startMs) => ({ startMs, endMs: null, text: timeToTexts.get(startMs)!.join("\n") }));
}

/**
 * SRT / VTT 解析：两者都是"可选标识行 + 时间行（start --> end）+ 文本行"的块结构。
 * VTT 的 WEBVTT 头、NOTE / STYLE / REGION 块不含 "-->"，会被自然跳过；
 * 时间行后的 VTT cue settings（如 line:90%）同样被忽略。
 */
function parseArrowCues(content: string, isVtt: boolean): Cue[] {
  const timing = new RegExp(`^${CLOCK}\\s*-->\\s*${CLOCK}`);
  const cues: Cue[] = [];
  for (const lines of splitBlocks(content)) {
    const index = lines.findIndex((line) => line.includes("-->"));
    if (index === -1) continue;
    const match = timing.exec(lines[index]);
    if (!match) continue;
    const text = lines.slice(index + 1).join("\n");
    if (!text) continue;
    cues.push({
      startMs: clockToMs(match, 1),
      endMs: clockToMs(match, 5),
      text: isVtt ? vttToInternal(text) : text,
    });
  }
  return cues;
}

/** SBV 解析："H:MM:SS.mmm,H:MM:SS.mmm" 时间行 + 纯文本，部分导出工具用 [br] 表示换行 */
function parseSbv(content: string): Cue[] {
  const timing = new RegExp(`^${CLOCK}\\s*,\\s*${CLOCK}\\s*$`);
  const cues: Cue[] = [];
  for (const lines of splitBlocks(content)) {
    const match = timing.exec(lines[0]);
    if (!match) continue;
    const text = cleanLines(lines.slice(1).join("\n").replace(/\[br\]/gi, "\n"));
    if (!text) continue;
    cues.push({ startMs: clockToMs(match, 1), endMs: clockToMs(match, 5), text });
  }
  return cues;
}

/** ASS 与 SSA 的 [Events] 默认字段顺序（缺少 Format 行时使用；SSA 首字段为 Marked） */
const DEFAULT_EVENT_FORMAT = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];

/**
 * ASS / SSA 解析：读取 [V4+ Styles] / [V4 Styles] 中的粗体、斜体、下划线作为基础样式，
 * 再按 [Events] 的 Format 行切分 Dialogue 字段（Text 为最后一个字段，可含逗号）。
 * Comment 行被跳过；时间相同且文本相同的重复事件（常见于多图层特效）只保留一条。
 */
function parseAss(content: string): Cue[] {
  const styles = new Map<string, Mark[]>();
  const events: { startMs: number; endMs: number; style: string; text: string }[] = [];
  let section = "";
  let styleFormat: string[] | undefined;
  let eventFormat: string[] | undefined;
  const assTime = new RegExp(`^${CLOCK}$`);

  for (const rawLine of normalizeContent(content).split("\n")) {
    const line = rawLine.trim();
    const heading = /^\[(.+)\]$/.exec(line);
    if (heading) {
      section = heading[1].trim().toLowerCase();
      continue;
    }
    if (!line || line.startsWith(";")) continue;
    const format = /^Format\s*:\s*(.*)$/i.exec(line);
    const fields = format?.[1].split(",").map((field) => field.trim().toLowerCase());

    if (section === "v4+ styles" || section === "v4 styles") {
      if (fields) {
        styleFormat = fields;
        continue;
      }
      const style = /^Style\s*:\s*(.*)$/i.exec(line);
      if (!style || !styleFormat) continue;
      const values = style[1].split(",").map((value) => value.trim());
      const name = values[styleFormat.indexOf("name")];
      if (!name) continue;
      const marks = (
        [["bold", "b"], ["italic", "i"], ["underline", "u"]] as const
      )
        // ASS 用 -1 表示开启（也接受 1），SSA 同理；缺失字段为 NaN 视为关闭
        .filter(([field]) => !!Number(values[styleFormat!.indexOf(field)]))
        .map(([, mark]) => mark);
      styles.set(name, marks);
    } else if (section === "events") {
      if (fields) {
        eventFormat = fields;
        continue;
      }
      const dialogue = /^Dialogue\s*:\s*(.*)$/i.exec(line);
      if (!dialogue) continue;
      const order = eventFormat ?? DEFAULT_EVENT_FORMAT;
      const values: string[] = [];
      let rest = dialogue[1];
      for (let index = 0; index < order.length - 1; index++) {
        const comma = rest.indexOf(",");
        if (comma < 0) break;
        values.push(rest.slice(0, comma).trim());
        rest = rest.slice(comma + 1);
      }
      if (values.length !== order.length - 1) continue;
      const start = assTime.exec(values[order.indexOf("start")] ?? "");
      const end = assTime.exec(values[order.indexOf("end")] ?? "");
      if (!start || !end) continue;
      events.push({
        startMs: clockToMs(start, 1),
        endMs: clockToMs(end, 1),
        style: (values[order.indexOf("style")] ?? "").replace(/^\*/, ""),
        text: rest,
      });
    }
  }

  const seen = new Set<string>();
  const cues: Cue[] = [];
  for (const event of events) {
    const text = assToInternal(event.text, styles.get(event.style) ?? [], styles);
    const key = `${event.startMs}|${event.endMs}|${text}`;
    if (!text || seen.has(key)) continue;
    seen.add(key);
    cues.push({ startMs: event.startMs, endMs: event.endMs, text });
  }
  // ASS 事件常按图层或样式分组排列，输出前按开始时间稳定排序
  return cues.sort((a, b) => a.startMs - b.startMs);
}

function parseCues(content: string, format: SubtitleConvertFormat): Cue[] {
  switch (format) {
    case "LRC":
      return parseLrc(content);
    case "SRT":
      return parseArrowCues(content, false);
    case "VTT":
      return parseArrowCues(content, true);
    case "SBV":
      return parseSbv(content);
    case "ASS":
    case "SSA":
      return parseAss(content);
  }
}

/**
 * 为没有结束时间的条目（来自 LRC）推算结束时间：
 * 结束时间 = 下一个更晚条目的开始时间，最后一条使用 defaultDurationMs 兜底，
 * 并保证至少持续 MIN_DURATION_MS。
 */
function resolveEndTimes(cues: Cue[], defaultDurationMs: number): (Cue & { endMs: number })[] {
  const starts = [...new Set(cues.map((cue) => cue.startMs))].sort((a, b) => a - b);
  const nextStarts = new Map(starts.map((start, index) => [start, starts[index + 1]]));
  return cues.map((cue) => {
    if (cue.endMs !== null) return { ...cue, endMs: Math.max(cue.startMs, cue.endMs) };
    const next = nextStarts.get(cue.startMs);
    const end = Math.max(cue.startMs + MIN_DURATION_MS, next ?? cue.startMs + defaultDurationMs);
    return { ...cue, endMs: end };
  });
}

// ────────────────────────────────────────────────
//  序列化：Cue[] → 目标格式
// ────────────────────────────────────────────────

/** 毫秒 → HH:MM:SS{sep}mmm（SRT 用逗号，VTT 用点号） */
function toClock(ms: number, separator: string, padHours = true): string {
  const hours = Math.floor(ms / 3600000);
  return `${padHours ? pad(hours) : hours}:${pad(Math.floor(ms / 60000) % 60)}:${pad(
    Math.floor(ms / 1000) % 60
  )}${separator}${pad(ms % 1000, 3)}`;
}

/** 毫秒 → LRC 时间戳 [MM:SS.xx]（厘秒精度，上限 99） */
function toLrcTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hundredths = Math.min(99, Math.round((ms % 1000) / 10));
  return `[${pad(Math.floor(totalSeconds / 60))}:${pad(totalSeconds % 60)}.${pad(hundredths)}]`;
}

/** 毫秒 → ASS 时间戳 H:MM:SS.cc（厘秒） */
function toAssTimestamp(ms: number): string {
  const centis = Math.round(ms / 10);
  return `${Math.floor(centis / 360000)}:${pad(Math.floor(centis / 6000) % 60)}:${pad(
    Math.floor(centis / 100) % 60
  )}.${pad(centis % 100)}`;
}

/** LRC 只保留开始时间；多行文本合并为单行（LRC 每行只允许一条歌词） */
function serializeLrc(cues: Cue[]): string {
  return cues
    .map((cue) => {
      const text = toPlainText(cue.text).split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
      return text ? `${toLrcTimestamp(cue.startMs)}${text}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function serializeSrt(cues: (Cue & { endMs: number })[]): string {
  return cues
    .map((cue, index) => `${index + 1}\n${toClock(cue.startMs, ",")} --> ${toClock(cue.endMs, ",")}\n${cue.text}`)
    .join("\n\n");
}

function serializeVtt(cues: (Cue & { endMs: number })[]): string {
  // VTT 要求结束时间严格晚于开始时间
  const blocks = cues.map((cue) => {
    const end = Math.max(cue.endMs, cue.startMs + 1);
    return `${toClock(cue.startMs, ".")} --> ${toClock(end, ".")}\n${toVttText(cue.text)}`;
  });
  return `WEBVTT\n\n${blocks.join("\n\n")}`;
}

function serializeSbv(cues: (Cue & { endMs: number })[]): string {
  return cues
    .map((cue) => `${toClock(cue.startMs, ".", false)},${toClock(cue.endMs, ".", false)}\n${toPlainText(cue.text)}`)
    .join("\n\n");
}

/** ASS 与 SSA 共用事件文本语法；SSA 的 Dialogue 首字段为 Marked=0，ASS 为图层号 */
function serializeAss(cues: (Cue & { endMs: number })[], variant: "ASS" | "SSA"): string {
  const header = variant === "SSA" ? SSA_HEADER : ASS_HEADER;
  const first = variant === "SSA" ? "Marked=0" : "0";
  const events = cues.map(
    (cue) =>
      `Dialogue: ${first},${toAssTimestamp(cue.startMs)},${toAssTimestamp(cue.endMs)},Default,,0,0,0,,${toAssText(cue.text)}`
  );
  return `${header}${events.join("\n")}`;
}

const OUTPUT_EXTENSIONS: Record<SubtitleConvertFormat, string> = {
  LRC: ".lrc",
  SRT: ".srt",
  VTT: ".vtt",
  ASS: ".ass",
  SSA: ".ssa",
  SBV: ".sbv",
};

/**
 * 字幕格式转换的统一入口。
 *
 * 解析源格式 → 统一 Cue 列表 → 序列化为目标格式，并推导输出文件名。
 * 不支持 from === to（同格式不需要转换，且可能覆盖源文件）。
 */
export function convertSubtitle(params: ConvertParams): ConvertResult {
  const { fileName, fileContent, from, to, defaultDurationMs, stripMediaExt } = params;
  if (from === to || !(from in OUTPUT_EXTENSIONS) || !(to in OUTPUT_EXTENSIONS)) {
    throw new Error(`Unsupported conversion: ${from} -> ${to}`);
  }

  const cues = parseCues(fileContent, from);
  if (cues.length === 0) {
    throw new Error(`No subtitle entries were found in the ${from} file.`);
  }

  let outputContent: string;
  if (to === "LRC") {
    outputContent = serializeLrc(cues);
  } else {
    const timed = resolveEndTimes(cues, defaultDurationMs ?? 2000);
    if (to === "SRT") outputContent = serializeSrt(timed);
    else if (to === "VTT") outputContent = serializeVtt(timed);
    else if (to === "SBV") outputContent = serializeSbv(timed);
    else outputContent = serializeAss(timed, to);
  }

  const outputBaseName = getOutputBaseName(fileName, stripMediaExt);
  return {
    outputFileName: `${outputBaseName}${OUTPUT_EXTENSIONS[to]}`,
    outputContent: `${outputContent}\n`,
  };
}
