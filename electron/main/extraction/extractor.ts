import path from "path";

export type KeepLanguage = "ZH" | "JA";

export interface ExtractParams {
  fileName: string;
  fileContent: string;
  fileType: "LRC" | "SRT";
  keep: KeepLanguage;
}

export interface ExtractResult {
  outputFileName: string;
  outputContent: string;
}

// 语言特征判定
const reKana = /[\u3040-\u30FF\uFF66-\uFF9D]/; // 平/片假名 + 半角片假名
const reJapPunct = /[、。「」『』・〜ー]/;
const reCnPunct = /[，。！？：；、“”‘’、（）《》【】]/;
const reCnFunc =
  /[的了在是我你他她它们这那着啊吧吗呢和与将会一个没有不是还有已经可以因为所以如果但是就是]/;
// 一小部分常见简体专属字（用于在无假名时区分 ZH/JA，例如 乐/楽）
const SIMP_ONLY =
  /[乐么们这那国齐礼专业为云亿仅从众优会传伤伞伟伪余伙价体佣儿册军农冲决净兰兴养兽内册写冲击冻划则别删刘华协单卖卢卫厂厅历厉压县参双发变叠叶号后吗问间难]/;

function hasKana(text: string): boolean {
  return reKana.test(text);
}

function classifyLine(text: string): "JA" | "ZH" | "UNKNOWN" {
  if (!text) return "UNKNOWN";
  const t = text.trim();
  if (!t) return "UNKNOWN";

  // 明确日文特征
  if (
    hasKana(t) ||
    reJapPunct.test(t) ||
    /(です|ます|だ|だった|ない|たい|よう|から|まで|って|では|じゃ|か|ね|よ)/.test(
      t
    )
  ) {
    return "JA";
  }

  // 明确中文特征
  if (reCnPunct.test(t) || reCnFunc.test(t) || SIMP_ONLY.test(t)) {
    return "ZH";
  }

  // 无明显特征
  return "UNKNOWN";
}

function parseSrtTimestamp(line: string): boolean {
  return /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/.test(
    line
  );
}

function chooseLinesForKeep(lines: string[], keep: KeepLanguage): string[] {
  const types = lines.map((l) => classifyLine(l));
  if (keep === "ZH") {
    const zh = lines.filter((_, i) => types[i] === "ZH");
    if (zh.length > 0) return zh;
    // 无中文则不保留（避免把纯日文/英文误判为中文）
    return [];
  } else {
    const ja = lines.filter((_, i) => types[i] === "JA");
    if (ja.length > 0) return ja;
    // 兜底：若恰好两行且其中一行被判为中文，则另一行视为日文（常见中日双语成对）
    if (lines.length === 2) {
      const idxZh = types.indexOf("ZH");
      if (idxZh !== -1) {
        const otherIdx = idxZh === 0 ? 1 : 0;
        return [lines[otherIdx]];
      }
    }
    // 多行场景：存在中文则保留非中文的行作为日文候选
    if (types.includes("ZH")) {
      return lines.filter((_, i) => types[i] !== "ZH");
    }
    return [];
  }
}

// LRC 解析与提取：按时间戳聚合，只保留目标语言的一行
function extractFromLRC(content: string, keep: KeepLanguage): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  type LrcEntry = { timeMs: number; rawTag: string; text: string };
  const entries: LrcEntry[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const timeTags = [
      ...line.matchAll(/\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/g),
    ];
    if (timeTags.length === 0) continue;

    const text = line.replace(/\[[^\]]+\]/g, "").trim();
    // 允许空文本（少见），但后续会被过滤

    for (const m of timeTags) {
      const mm = parseInt(m[1] || "0", 10);
      const ss = parseInt(m[2] || "0", 10);
      const fracRaw = m[3] || "0";
      let ms = 0;
      if (fracRaw.length === 3) ms = parseInt(fracRaw, 10);
      else if (fracRaw.length === 2) ms = parseInt(fracRaw, 10) * 10;
      else if (fracRaw.length === 1) ms = parseInt(fracRaw, 10) * 100;
      const timeMs = mm * 60000 + ss * 1000 + ms;
      entries.push({ timeMs, rawTag: m[0], text });
    }
  }

  // 按时间聚合
  const timeToTexts = new Map<number, { rawTag: string; texts: string[] }>();
  for (const e of entries) {
    const rec = timeToTexts.get(e.timeMs) || { rawTag: e.rawTag, texts: [] };
    // 保留首次出现的时间标签格式
    if (!timeToTexts.has(e.timeMs)) {
      timeToTexts.set(e.timeMs, { rawTag: e.rawTag, texts: [] });
    }
    const cur = timeToTexts.get(e.timeMs)!;
    if (e.text) cur.texts.push(e.text);
  }

  const times = Array.from(timeToTexts.keys()).sort((a, b) => a - b);
  const outLines: string[] = [];

  for (const t of times) {
    const { rawTag, texts } = timeToTexts.get(t)!;
    if (texts.length === 0) continue;

    const kept = chooseLinesForKeep(texts, keep);
    if (kept.length === 0) continue;

    // 每个时间点保留一行（取第一候选）
    outLines.push(`${rawTag}${kept[0]}`);
  }

  return outLines.join("\n");
}

function extractFromSRT(content: string, keep: KeepLanguage): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";

  const blocks = normalized.split(/\n\s*\n+/);
  const resultBlocks: string[] = [];
  let index = 1;

  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) continue;

    let tsLineIdx = -1;
    let startAt = 0;

    if (
      lines.length >= 2 &&
      parseSrtTimestamp(lines[1]) &&
      /^\d+$/.test(lines[0])
    ) {
      tsLineIdx = 1;
      startAt = 2;
    } else if (parseSrtTimestamp(lines[0])) {
      tsLineIdx = 0;
      startAt = 1;
    } else {
      continue; // 非法块
    }

    const timestampLine = lines[tsLineIdx];
    const textLines = lines.slice(startAt);
    if (textLines.length === 0) continue;

    const kept = chooseLinesForKeep(textLines, keep);
    if (kept.length === 0) {
      // 若仅日文模式且存在两行一中一未知，chooseLinesForKeep 已处理兜底
      continue;
    }

    const newBlock = `${index}\n${timestampLine}\n${kept.join("\n")}`;
    resultBlocks.push(newBlock);
    index++;
  }

  return resultBlocks.join("\n\n");
}

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

  const outputFileName = `${parsed.name}${parsed.ext}`; // 保持原扩展名
  return { outputFileName, outputContent };
}
