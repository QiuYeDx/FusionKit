/**
 * 字幕语言提取器
 *
 * 从中日双语字幕文件（LRC / SRT）中识别并提取指定语言的文本行。
 * 核心流程：逐行语言分类 → 按时间/区块聚合 → 保留目标语言行 → 重组输出。
 */
import path from "path";

/** 要保留的目标语言：ZH = 中文，JA = 日文 */
export type KeepLanguage = "ZH" | "JA";

export interface ExtractParams {
  fileName: string;
  fileContent: string;
  fileType: "LRC" | "SRT";
  /** 指定要保留哪种语言 */
  keep: KeepLanguage;
}

export interface ExtractResult {
  outputFileName: string;
  outputContent: string;
}

// ─── 语言特征正则 ───────────────────────────────────────
// 判定优先级：假名 / 日文标点 / 日文助词 → JA；中文标点 / 虚词 / 简体字 → ZH

/** 平假名 + 片假名 + 半角片假名，出现即确定为日文 */
const reKana = /[\u3040-\u30FF\uFF66-\uFF9D]/;
/** 日文专用标点（「」、。等），中文不使用这些 */
const reJapPunct = /[、。「」『』・〜ー]/;
/** 中文全角标点，日文不使用 */
const reCnPunct = /[，。！？：；、""''、（）《》【】]/;
/** 高频中文虚词/功能词，出现即可判定为中文句子 */
const reCnFunc =
  /[的了在是我你他她它们这那着啊吧吗呢和与将会一个没有不是还有已经可以因为所以如果但是就是]/;
/** 简体字独有字形（与繁体/日文汉字不同），用于无假名时区分 ZH/JA（如 乐→楽） */
const SIMP_ONLY =
  /[乐么们这那国齐礼专业为云亿仅从众优会传伤伞伟伪余伙价体佣儿册军农冲决净兰兴养兽内册写冲击冻划则别删刘华协单卖卢卫厂厅历厉压县参双发变叠叶号后吗问间难]/;

function hasKana(text: string): boolean {
  return reKana.test(text);
}

/**
 * 对单行文本进行语言分类。
 *
 * 判定策略（短路优先）：
 * 1. 含假名 / 日文标点 / 日文常见助词 → JA
 * 2. 含中文标点 / 中文虚词 / 简体专属字 → ZH
 * 3. 以上都不满足 → UNKNOWN（纯英文、纯数字等）
 */
function classifyLine(text: string): "JA" | "ZH" | "UNKNOWN" {
  if (!text) return "UNKNOWN";
  const t = text.trim();
  if (!t) return "UNKNOWN";

  if (
    hasKana(t) ||
    reJapPunct.test(t) ||
    /(です|ます|だ|だった|ない|たい|よう|から|まで|って|では|じゃ|か|ね|よ)/.test(
      t
    )
  ) {
    return "JA";
  }

  if (reCnPunct.test(t) || reCnFunc.test(t) || SIMP_ONLY.test(t)) {
    return "ZH";
  }

  return "UNKNOWN";
}

/** 判断是否为 SRT 时间轴行，格式：00:01:23,456 --> 00:01:25,789 */
function parseSrtTimestamp(line: string): boolean {
  return /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/.test(
    line
  );
}

/**
 * 从同一时间点/区块的多行文本中，筛选出目标语言的行。
 *
 * 保留 ZH 时：直接过滤出被判定为 ZH 的行，没有则返回空。
 * 保留 JA 时：
 *   - 优先返回被判定为 JA 的行
 *   - 兜底策略 1：恰好 2 行且其中一行是 ZH → 另一行视为 JA（典型中日双语成对）
 *   - 兜底策略 2：多行中存在 ZH → 排除 ZH 后的行视为 JA 候选
 */
function chooseLinesForKeep(lines: string[], keep: KeepLanguage): string[] {
  const types = lines.map((l) => classifyLine(l));
  if (keep === "ZH") {
    const zh = lines.filter((_, i) => types[i] === "ZH");
    if (zh.length > 0) return zh;
    return [];
  } else {
    const ja = lines.filter((_, i) => types[i] === "JA");
    if (ja.length > 0) return ja;
    // 兜底策略 1：双行中排除中文行
    if (lines.length === 2) {
      const idxZh = types.indexOf("ZH");
      if (idxZh !== -1) {
        const otherIdx = idxZh === 0 ? 1 : 0;
        return [lines[otherIdx]];
      }
    }
    // 兜底策略 2：多行中排除中文行
    if (types.includes("ZH")) {
      return lines.filter((_, i) => types[i] !== "ZH");
    }
    return [];
  }
}

/**
 * 从 LRC 歌词文件中提取目标语言。
 *
 * LRC 格式示例：
 *   [01:23.45]中文歌词
 *   [01:23.45]日本語の歌詞
 *
 * 处理流程：
 * 1. 解析每行的时间标签（支持 [mm:ss.xxx]，一行可含多个标签）
 * 2. 将文本按时间戳聚合（同一时刻的中日两行归为一组）
 * 3. 对每组调用 chooseLinesForKeep 筛选目标语言
 * 4. 按时间升序输出，每个时间点只保留一行
 */
function extractFromLRC(content: string, keep: KeepLanguage): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  type LrcEntry = { timeMs: number; rawTag: string; text: string };
  const entries: LrcEntry[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // 匹配所有时间标签 [mm:ss.xxx]，一行可能有多个（如 [01:23.45][01:23.46]歌词）
    const timeTags = [
      ...line.matchAll(/\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/g),
    ];
    if (timeTags.length === 0) continue;

    // 去除所有方括号标签后的纯文本
    const text = line.replace(/\[[^\]]+\]/g, "").trim();

    for (const m of timeTags) {
      const mm = parseInt(m[1] || "0", 10);
      const ss = parseInt(m[2] || "0", 10);
      // 小数部分需按位数归一化到毫秒（如 .45 → 450ms，.456 → 456ms）
      const fracRaw = m[3] || "0";
      let ms = 0;
      if (fracRaw.length === 3) ms = parseInt(fracRaw, 10);
      else if (fracRaw.length === 2) ms = parseInt(fracRaw, 10) * 10;
      else if (fracRaw.length === 1) ms = parseInt(fracRaw, 10) * 100;
      const timeMs = mm * 60000 + ss * 1000 + ms;
      entries.push({ timeMs, rawTag: m[0], text });
    }
  }

  // 将同一时间戳的多条文本归入同一组，便于后续按语言筛选
  const timeToTexts = new Map<number, { rawTag: string; texts: string[] }>();
  for (const e of entries) {
    const rec = timeToTexts.get(e.timeMs) || { rawTag: e.rawTag, texts: [] };
    if (!timeToTexts.has(e.timeMs)) {
      timeToTexts.set(e.timeMs, { rawTag: e.rawTag, texts: [] });
    }
    const cur = timeToTexts.get(e.timeMs)!;
    if (e.text) cur.texts.push(e.text);
  }

  // 按时间升序遍历，对每组文本筛选目标语言后输出
  const times = Array.from(timeToTexts.keys()).sort((a, b) => a - b);
  const outLines: string[] = [];

  for (const t of times) {
    const { rawTag, texts } = timeToTexts.get(t)!;
    if (texts.length === 0) continue;

    const kept = chooseLinesForKeep(texts, keep);
    if (kept.length === 0) continue;

    outLines.push(`${rawTag}${kept[0]}`);
  }

  return outLines.join("\n");
}

/**
 * 从 SRT 字幕文件中提取目标语言。
 *
 * SRT 格式示例（每个字幕块由空行分隔）：
 *   1
 *   00:01:23,456 --> 00:01:25,789
 *   中文字幕
 *   日本語字幕
 *
 * 处理流程：
 * 1. 按空行拆分为字幕块
 * 2. 识别每块的序号行和时间轴行（兼容无序号的情况）
 * 3. 提取文本行并通过 chooseLinesForKeep 筛选目标语言
 * 4. 重新编号并组装输出
 */
function extractFromSRT(content: string, keep: KeepLanguage): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";

  // 按一个或多个空行拆分为独立字幕块
  const blocks = normalized.split(/\n\s*\n+/);
  const resultBlocks: string[] = [];
  let index = 1; // 输出序号（重新从 1 编号）

  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) continue;

    // 定位时间轴行：标准格式为 [序号, 时间轴, 文本...]，也兼容无序号的情况
    let tsLineIdx = -1;
    let startAt = 0;

    if (
      lines.length >= 2 &&
      parseSrtTimestamp(lines[1]) &&
      /^\d+$/.test(lines[0])
    ) {
      // 标准格式：第 0 行是序号，第 1 行是时间轴
      tsLineIdx = 1;
      startAt = 2;
    } else if (parseSrtTimestamp(lines[0])) {
      // 无序号：第 0 行直接是时间轴
      tsLineIdx = 0;
      startAt = 1;
    } else {
      continue;
    }

    const timestampLine = lines[tsLineIdx];
    const textLines = lines.slice(startAt);
    if (textLines.length === 0) continue;

    const kept = chooseLinesForKeep(textLines, keep);
    if (kept.length === 0) continue;

    // 重新组装：序号 + 时间轴 + 保留的文本行
    const newBlock = `${index}\n${timestampLine}\n${kept.join("\n")}`;
    resultBlocks.push(newBlock);
    index++;
  }

  return resultBlocks.join("\n\n");
}

/**
 * 字幕提取入口函数。
 * 根据文件类型分发到 LRC / SRT 处理器，返回提取后的文件名和内容。
 */
export function extractSubtitle(params: ExtractParams): ExtractResult {
  const { fileName, fileContent, fileType, keep } = params;
  const parsed = path.parse(fileName);
  let outputContent = "";

  if (fileType === "LRC") {
    outputContent = extractFromLRC(fileContent, keep);
  } else if (fileType === "SRT") {
    outputContent = extractFromSRT(fileContent, keep);
  } else {
    throw new Error(`Unsupported file type: ${fileType}`);
  }

  const outputFileName = `${parsed.name}${parsed.ext}`;
  return { outputFileName, outputContent };
}
