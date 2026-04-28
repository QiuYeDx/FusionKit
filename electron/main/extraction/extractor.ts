/**
 * 字幕语言提取器
 *
 * 从双语字幕文件（LRC / SRT）中识别并提取指定语言的文本行。
 * 核心流程：逐行 Unicode Script 检测 → 按时间/区块聚合 → 保留目标语言行 → 重组输出。
 *
 * 支持的语言：ZH / JA / EN / KO / FR / DE / ES / RU / PT
 * 检测策略基于 Unicode 脚本范围，而非特定语言的硬编码正则。
 */
import path from "path";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * 要保留的目标语言。
 * 复用渲染进程的 TranslationLanguage 联合类型值。
 */
export type ExtractKeepLanguage =
  | "ZH"
  | "JA"
  | "EN"
  | "KO"
  | "FR"
  | "DE"
  | "ES"
  | "RU"
  | "PT";

export interface ExtractParams {
  fileName: string;
  fileContent: string;
  fileType: "LRC" | "SRT";
  /** 指定要保留哪种语言 */
  keep: ExtractKeepLanguage;
}

export interface ExtractResult {
  outputFileName: string;
  outputContent: string;
}

// ---------------------------------------------------------------------------
// Unicode Script 检测
// ---------------------------------------------------------------------------

/**
 * 脚本类别——用于将文本行归类到大的书写系统类别。
 *
 * - CJK_ZH: CJK 汉字（不含假名）→ 中文
 * - KANA_JA: 含平假名/片假名 → 日文
 * - HANGUL: 含韩文音节/字母 → 韩语
 * - CYRILLIC: 含西里尔字母 → 俄语
 * - LATIN: 拉丁字母为主 → 英/法/德/西/葡
 * - UNKNOWN: 无法归类（纯数字/符号等）
 */
type ScriptCategory =
  | "CJK_ZH"
  | "KANA_JA"
  | "HANGUL"
  | "CYRILLIC"
  | "LATIN"
  | "UNKNOWN";

// ─── 脚本特征正则 ─────────────────────────────────────

/** 平假名 + 片假名 + 半角片假名 */
const reKana = /[\u3040-\u30FF\uFF66-\uFF9D]/;

/** 韩文音节块 + 韩文字母（兼容/相容字母） */
const reHangul = /[\uAC00-\uD7AF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF]/;

/** 西里尔字母（基本 + 补充） */
const reCyrillic = /[\u0400-\u04FF\u0500-\u052F]/;

/** CJK 统一汉字（基本区 + 扩展 A） */
const reCJK = /[\u4E00-\u9FFF\u3400-\u4DBF]/;

/** 基本拉丁字母（含扩展拉丁 A/B、拉丁扩展附加、重音字母等） */
const reLatin = /[\u0041-\u007A\u00C0-\u024F\u1E00-\u1EFF]/;

// ─── ZH / JA 细分正则（用于 CJK 场景下的二次区分） ────

/** 日文专用标点 */
const reJapPunct = /[、。「」『』・〜ー]/;

/** 日文常见助词/语尾 */
const reJapGrammar =
  /(です|ます|だ|だった|ない|たい|よう|から|まで|って|では|じゃ|か|ね|よ)/;

/** 中文全角标点 */
const reCnPunct = /[，。！？：；、""''、（）《》【】]/;

/** 高频中文虚词/功能词 */
const reCnFunc =
  /[的了在是我你他她它们这那着啊吧吗呢和与将会一个没有不是还有已经可以因为所以如果但是就是]/;

/** 简体字独有字形 */
const SIMP_ONLY =
  /[乐么们这那国齐礼专业为云亿仅从众优会传伤伞伟伪余伙价体佣儿册军农冲决净兰兴养兽内册写冲击冻划则别删刘华协单卖卢卫厂厅历厉压县参双发变叠叶号后吗问间难]/;

/**
 * 对单行文本进行 Unicode 脚本分类。
 *
 * 判定策略（短路优先）：
 * 1. 含假名 → KANA_JA（即使同时含汉字，有假名说明是日文）
 * 2. 含韩文 → HANGUL
 * 3. 含西里尔 → CYRILLIC
 * 4. 含 CJK 汉字（已排除假名）→ CJK_ZH
 * 5. 含拉丁字母 → LATIN
 * 6. 以上都不满足 → UNKNOWN
 */
function detectLineScript(text: string): ScriptCategory {
  if (!text) return "UNKNOWN";
  const t = text.trim();
  if (!t) return "UNKNOWN";

  // 假名优先（日文）
  if (reKana.test(t) || reJapPunct.test(t) || reJapGrammar.test(t)) {
    return "KANA_JA";
  }

  // 韩文
  if (reHangul.test(t)) {
    return "HANGUL";
  }

  // 西里尔
  if (reCyrillic.test(t)) {
    return "CYRILLIC";
  }

  // CJK 汉字（已排除假名场景）→ 中文
  if (reCJK.test(t)) {
    // 额外验证：如果有中文标点/虚词/简体字特征，更确定是中文
    // 即使没有这些特征，纯 CJK 无假名也归为中文
    return "CJK_ZH";
  }

  // 拉丁字母
  if (reLatin.test(t)) {
    return "LATIN";
  }

  return "UNKNOWN";
}

/**
 * 将用户选择的目标语言映射到对应的 ScriptCategory。
 */
function getScriptForLanguage(lang: ExtractKeepLanguage): ScriptCategory {
  switch (lang) {
    case "ZH":
      return "CJK_ZH";
    case "JA":
      return "KANA_JA";
    case "KO":
      return "HANGUL";
    case "RU":
      return "CYRILLIC";
    // EN, FR, DE, ES, PT 都属于拉丁脚本
    default:
      return "LATIN";
  }
}

/**
 * ZH/JA 场景下的细分判定。
 * 当目标是 ZH 但行被检测为 KANA_JA 时返回 false，反之亦然。
 * 用于处理中日双语字幕中 CJK 行的精确区分。
 */
function isZhLine(text: string): boolean {
  return reCnPunct.test(text) || reCnFunc.test(text) || SIMP_ONLY.test(text);
}

/**
 * 从同一时间点/区块的多行文本中，筛选出目标语言的行。
 *
 * 通用策略：
 * 1. 检测每行的 ScriptCategory
 * 2. 保留与目标语言 script 匹配的行
 * 3. ZH/JA 特殊处理：两者都可能含 CJK，需二次区分
 * 4. 兜底策略：排除已确定的非目标行
 */
function chooseLinesForKeep(
  lines: string[],
  keep: ExtractKeepLanguage
): string[] {
  const targetScript = getScriptForLanguage(keep);
  const scripts = lines.map((l) => detectLineScript(l));

  // ---- ZH / JA 特殊处理 ----
  // 中日双语字幕中，两种语言都可能含 CJK 汉字
  if (keep === "ZH") {
    // 目标是中文：优先选 CJK_ZH 行，同时排除 KANA_JA 行
    const zhLines = lines.filter(
      (l, i) => scripts[i] === "CJK_ZH" || (scripts[i] !== "KANA_JA" && isZhLine(l))
    );
    if (zhLines.length > 0) return zhLines;

    // 兜底：如果有 KANA_JA 行，排除它们后剩余的可能是中文
    if (scripts.includes("KANA_JA")) {
      const nonJa = lines.filter((_, i) => scripts[i] !== "KANA_JA");
      if (nonJa.length > 0) return nonJa;
    }
    return [];
  }

  if (keep === "JA") {
    // 目标是日文：优先选 KANA_JA 行
    const jaLines = lines.filter((_, i) => scripts[i] === "KANA_JA");
    if (jaLines.length > 0) return jaLines;

    // 兜底策略 1：双行中排除中文行
    if (lines.length === 2) {
      const zhIdx = scripts.findIndex(
        (s, i) => s === "CJK_ZH" || isZhLine(lines[i])
      );
      if (zhIdx !== -1) {
        const otherIdx = zhIdx === 0 ? 1 : 0;
        return [lines[otherIdx]];
      }
    }
    // 兜底策略 2：多行中排除中文行
    const hasZh = scripts.some((s, i) => s === "CJK_ZH" || isZhLine(lines[i]));
    if (hasZh) {
      const nonZh = lines.filter(
        (l, i) => scripts[i] !== "CJK_ZH" && !isZhLine(l)
      );
      if (nonZh.length > 0) return nonZh;
    }
    return [];
  }

  // ---- 通用处理 ----
  // 直接按 script 类别匹配
  const matched = lines.filter((_, i) => scripts[i] === targetScript);
  if (matched.length > 0) return matched;

  // 兜底：排除已确定的其他 script 行
  const knownOther = lines.filter(
    (_, i) => scripts[i] !== "UNKNOWN" && scripts[i] !== targetScript
  );
  if (knownOther.length > 0 && knownOther.length < lines.length) {
    return lines.filter(
      (_, i) => scripts[i] === "UNKNOWN" || scripts[i] === targetScript
    );
  }

  return [];
}

/** 判断是否为 SRT 时间轴行，格式：00:01:23,456 --> 00:01:25,789 */
function parseSrtTimestamp(line: string): boolean {
  return /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/.test(
    line
  );
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
 * 2. 将文本按时间戳聚合（同一时刻的两行归为一组）
 * 3. 对每组调用 chooseLinesForKeep 筛选目标语言
 * 4. 按时间升序输出，每个时间点只保留一行
 */
function extractFromLRC(content: string, keep: ExtractKeepLanguage): string {
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
function extractFromSRT(content: string, keep: ExtractKeepLanguage): string {
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
