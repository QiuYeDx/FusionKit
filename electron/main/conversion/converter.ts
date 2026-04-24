/**
 * 字幕格式转换模块 —— 纯字符串转换，不涉及文件系统或 Electron API。
 *
 * 支持 LRC / SRT / VTT 三种格式之间的互转（共 6 条转换路径）。
 * 唯一对外暴露的入口是 convertSubtitle()，内部根据 from/to 分发到具体的转换函数。
 *
 * 三种格式的核心差异：
 *  - LRC：仅有开始时间 [mm:ss.xx]，无结束时间，精度为厘秒
 *  - SRT：有序号 + 开始/结束时间 HH:MM:SS,mmm（逗号分隔毫秒），精度为毫秒
 *  - VTT：类似 SRT 但以 "WEBVTT" 头部开头，时间戳用点分隔毫秒 HH:MM:SS.mmm
 */
import path from "path";

/** 转换输入参数 */
export type ConvertParams = {
  /** 原始文件名，用于推导输出文件名 */
  fileName: string;
  /** 原始字幕文件的文本内容 */
  fileContent: string;
  /** 源格式 */
  from: "LRC" | "SRT" | "VTT";
  /** 目标格式 */
  to: "LRC" | "SRT" | "VTT";
  /** LRC→SRT/VTT 时，为最后一条字幕或时间间隔过大的条目补充的默认持续时长（毫秒），默认 2000 */
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

/**
 * 常见音视频文件扩展名集合。
 * 用于 stripMediaExt 功能：当字幕文件名形如 "song.wav.srt" 时，
 * 可以额外剥离中间的 ".wav"，得到干净的基础名 "song"。
 */
const COMMON_MEDIA_EXTS = new Set([
  // 音频
  ".wav",
  ".mp3",
  ".flac",
  ".m4a",
  ".aac",
  ".ogg",
  ".opus",
  ".wma",
  // 视频
  ".mp4",
  ".mkv",
  ".avi",
  ".mov",
  ".wmv",
  ".webm",
  ".m4v",
  ".ts",
  ".m2ts",
]);

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
    const parsed2 = path.parse(base);
    const ext2 = parsed2.ext.toLowerCase();
    if (ext2 && COMMON_MEDIA_EXTS.has(ext2)) {
      base = parsed2.name;
    }
  }

  return base || "subtitle";
}

/** 数字补零到 2 位 */
function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

// ────────────────────────────────────────────────
//  时间戳 格式化 / 解析 工具函数
//  三种格式的时间戳表示方式各不相同：
//    SRT:  HH:MM:SS,mmm  （逗号 + 毫秒）
//    VTT:  HH:MM:SS.mmm  （点号 + 毫秒，小时可选）
//    LRC:  [MM:SS.xx]    （方括号 + 厘秒，无小时位）
// ────────────────────────────────────────────────

/** 毫秒 → SRT 时间戳 (HH:MM:SS,mmm) */
function toSrtTimestamp(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = Math.max(0, Math.floor(ms % 1000));
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)},${millis
    .toString()
    .padStart(3, "0")}`;
}

/** 毫秒 → VTT 时间戳 (HH:MM:SS.mmm) */
function toVttTimestamp(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = Math.max(0, Math.floor(ms % 1000));
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}.${millis
    .toString()
    .padStart(3, "0")}`;
}

/** SRT 时间戳 (HH:MM:SS,mmm) → 毫秒 */
function parseSrtTimestamp(ts: string): number {
  const m = ts.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
  if (!m) return 0;
  const [_, hh, mm, ss, mmm] = m;
  const hours = parseInt(hh, 10);
  const minutes = parseInt(mm, 10);
  const seconds = parseInt(ss, 10);
  const millis = parseInt(mmm, 10);
  return hours * 3600000 + minutes * 60000 + seconds * 1000 + millis;
}

/** VTT 时间戳 (HH:MM:SS.mmm 或 MM:SS.mmm) → 毫秒；小时部分可选 */
function parseVttTimestamp(ts: string): number {
  const m = ts.match(/(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})/);
  if (!m) return 0;
  const [_, hh, mm, ss, mmm] = m;
  const hours = hh ? parseInt(hh, 10) : 0;
  const minutes = parseInt(mm, 10);
  const seconds = parseInt(ss, 10);
  const millis = parseInt(mmm, 10);
  return hours * 3600000 + minutes * 60000 + seconds * 1000 + millis;
}

/** 毫秒 → LRC 时间戳 [MM:SS.xx]（厘秒精度，上限 99） */
function toLrcTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hundredths = Math.round((ms % 1000) / 10);
  return `[${pad2(minutes)}:${pad2(seconds)}.${pad2(
    Math.min(99, hundredths)
  )}]`;
}

// ────────────────────────────────────────────────
//  六条格式转换路径
// ────────────────────────────────────────────────

/**
 * LRC → SRT
 *
 * 核心难点：LRC 只有开始时间没有结束时间，因此需要推算结束时间。
 * 策略：当前条目的结束时间 = 下一条目的开始时间，最后一条使用 defaultDurationMs。
 * 同时保证每条字幕最短持续 300ms，防止闪现。
 *
 * LRC 支持"多时间标签"语法，如 [00:01.00][00:05.00]歌词，
 * 表示同一段文字在两个时间点出现，解析时会展开为多个条目。
 */
function convertLRCtoSRT(
  content: string,
  defaultDurationMs: number = 2000
): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  type LrcEntry = { timeMs: number; text: string };
  const entries: LrcEntry[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    // 匹配所有时间标签 [mm:ss.xx]，一行可能有多个
    const timeTags = [
      ...line.matchAll(/\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/g),
    ];
    if (timeTags.length === 0) continue;
    // 去掉所有方括号标签，剩余的即为歌词文本
    const text = line.replace(/\[[^\]]+\]/g, "").trim();
    if (!text) continue;
    // 每个时间标签都生成一个独立条目（多时间标签展开）
    for (const m of timeTags) {
      const mm = parseInt(m[1] || "0", 10);
      const ss = parseInt(m[2] || "0", 10);
      // 小数部分可能是 1~3 位，统一换算为毫秒
      const fracRaw = m[3] || "0";
      let ms = 0;
      if (fracRaw.length === 3) ms = parseInt(fracRaw, 10);
      else if (fracRaw.length === 2) ms = parseInt(fracRaw, 10) * 10;
      else if (fracRaw.length === 1) ms = parseInt(fracRaw, 10) * 100;
      const timeMs = mm * 60000 + ss * 1000 + ms;
      entries.push({ timeMs, text });
    }
  }

  // 按时间戳分组，同一时刻的多行文本合并（如双语字幕场景）
  const timeToTexts = new Map<number, string[]>();
  for (const e of entries) {
    const texts = timeToTexts.get(e.timeMs) || [];
    texts.push(e.text);
    timeToTexts.set(e.timeMs, texts);
  }

  const times = Array.from(timeToTexts.keys()).sort((a, b) => a - b);

  const blocks: string[] = [];
  for (let i = 0; i < times.length; i++) {
    const start = times[i];
    // 结束时间 = 下一条的开始时间，最后一条用 defaultDurationMs 兜底
    const endCandidate = times[i + 1] ?? start + defaultDurationMs;
    // 保证每条字幕至少持续 300ms，避免闪现
    const end = Math.max(start + 300, endCandidate);

    // 去重并用换行拼接（SRT 支持多行文本）
    const mergedText = Array.from(
      new Set(
        (timeToTexts.get(start) || []).map((t) => t.trim()).filter(Boolean)
      )
    ).join("\n");

    const idx = i + 1;
    const srtBlock = `${idx}\n${toSrtTimestamp(start)} --> ${toSrtTimestamp(
      end
    )}\n${mergedText}\n`;
    blocks.push(srtBlock);
  }

  return blocks.join("\n").trim();
}

/**
 * LRC → VTT
 *
 * 逻辑与 LRC→SRT 基本一致，区别：
 *  - 输出使用 VTT 时间戳格式（点号分隔毫秒）
 *  - 不需要序号
 *  - 输出开头添加 "WEBVTT" 文件头
 */
function convertLRCtoVTT(
  content: string,
  defaultDurationMs: number = 2000
): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  type LrcEntry = { timeMs: number; text: string };
  const entries: LrcEntry[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const timeTags = [
      ...line.matchAll(/\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/g),
    ];
    if (timeTags.length === 0) continue;
    const text = line.replace(/\[[^\]]+\]/g, "").trim();
    if (!text) continue;
    for (const m of timeTags) {
      const mm = parseInt(m[1] || "0", 10);
      const ss = parseInt(m[2] || "0", 10);
      const fracRaw = m[3] || "0";
      let ms = 0;
      if (fracRaw.length === 3) ms = parseInt(fracRaw, 10);
      else if (fracRaw.length === 2) ms = parseInt(fracRaw, 10) * 10;
      else if (fracRaw.length === 1) ms = parseInt(fracRaw, 10) * 100;
      const timeMs = mm * 60000 + ss * 1000 + ms;
      entries.push({ timeMs, text });
    }
  }

  const timeToTexts = new Map<number, string[]>();
  for (const e of entries) {
    const texts = timeToTexts.get(e.timeMs) || [];
    texts.push(e.text);
    timeToTexts.set(e.timeMs, texts);
  }

  const times = Array.from(timeToTexts.keys()).sort((a, b) => a - b);

  const blocks: string[] = [];
  for (let i = 0; i < times.length; i++) {
    const start = times[i];
    const endCandidate = times[i + 1] ?? start + defaultDurationMs;
    const end = Math.max(start + 300, endCandidate);

    const mergedText = Array.from(
      new Set(
        (timeToTexts.get(start) || []).map((t) => t.trim()).filter(Boolean)
      )
    ).join("\n");

    const vttBlock = `${toVttTimestamp(start)} --> ${toVttTimestamp(
      end
    )}\n${mergedText}\n`;
    blocks.push(vttBlock);
  }

  // VTT 文件必须以 "WEBVTT" 开头
  return "WEBVTT\n\n" + blocks.join("\n").trim();
}

/**
 * SRT → LRC
 *
 * SRT 有结束时间但 LRC 不支持，因此只保留每个块的开始时间。
 * SRT 块结构：序号 → 时间戳行 → 若干行文本，各块之间用空行分隔。
 * 多行文本会被合并为单行（用空格连接），因为 LRC 每行只允许一条歌词。
 */
function convertSRTtoLRC(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  // SRT 的块之间用一个或多个空行分隔
  const blocks = normalized.split(/\n\s*\n+/);
  const lines: string[] = [];

  for (const block of blocks) {
    const blines = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (blines.length === 0) continue;

    // 定位时间戳行（包含 "-->" 和 SRT 时间格式）
    let tsLineIdx = blines.findIndex(
      (l) => l.includes("-->") && /\d{2}:\d{2}:\d{2},\d{3}/.test(l)
    );
    if (tsLineIdx === -1) {
      // 兼容：第一行可能是序号，第二行才是时间戳
      if (
        blines.length >= 2 &&
        /\d+/.test(blines[0]) &&
        blines[1].includes("-->")
      ) {
        tsLineIdx = 1;
      } else {
        continue;
      }
    }
    const ts = blines[tsLineIdx];
    const m = ts.match(
      /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/
    );
    if (!m) continue;
    // LRC 只需要开始时间，丢弃结束时间
    const startMs = parseSrtTimestamp(m[1]);

    const textLines = blines.slice(tsLineIdx + 1);
    if (textLines.length === 0) continue;
    // 多行文本用空格合并为单行
    const text = textLines.join(" ").trim();

    lines.push(`${toLrcTimestamp(startMs)}${text}`);
  }

  return lines.join("\n").trim();
}

/**
 * VTT → LRC
 *
 * 与 SRT→LRC 类似：只保留开始时间，多行文本合并为单行。
 * 额外需要先去掉 VTT 的 "WEBVTT" 文件头。
 */
function convertVTTtoLRC(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  const withoutHeader = normalized.replace(/^WEBVTT[^\n]*\n+/, "");
  const blocks = withoutHeader.split(/\n\s*\n+/);
  const lines: string[] = [];

  for (const block of blocks) {
    const blines = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (blines.length === 0) continue;

    // VTT 时间戳用点号（.）而非逗号
    let tsLineIdx = blines.findIndex(
      (l) => l.includes("-->") && /\d{2}:\d{2}\.\d{3}/.test(l)
    );
    if (tsLineIdx === -1) continue;

    const ts = blines[tsLineIdx];
    const m = ts.match(
      /(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})/
    );
    if (!m) continue;
    const startMs = parseVttTimestamp(m[0].split("-->")[0].trim());

    const textLines = blines.slice(tsLineIdx + 1);
    if (textLines.length === 0) continue;
    const text = textLines.join(" ").trim();

    lines.push(`${toLrcTimestamp(startMs)}${text}`);
  }

  return lines.join("\n").trim();
}

/**
 * SRT → VTT
 *
 * SRT 和 VTT 结构非常接近，主要转换工作：
 *  - 去掉序号行（VTT 不需要）
 *  - 时间戳分隔符从逗号改为点号
 *  - 添加 "WEBVTT" 文件头
 *  - 开始/结束时间完整保留
 */
function convertSRTtoVTT(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  const blocks = normalized.split(/\n\s*\n+/);
  const vttBlocks: string[] = [];

  for (const block of blocks) {
    const blines = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (blines.length === 0) continue;

    let tsLineIdx = blines.findIndex(
      (l) => l.includes("-->") && /\d{2}:\d{2}:\d{2},\d{3}/.test(l)
    );
    if (tsLineIdx === -1) {
      if (
        blines.length >= 2 &&
        /\d+/.test(blines[0]) &&
        blines[1].includes("-->")
      ) {
        tsLineIdx = 1;
      } else {
        continue;
      }
    }
    const ts = blines[tsLineIdx];
    const m = ts.match(
      /(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/
    );
    if (!m) continue;
    // 先解析为毫秒，再格式化为 VTT 时间戳（逗号 → 点号）
    const startMs = parseSrtTimestamp(m[1]);
    const endMs = parseSrtTimestamp(m[2]);

    const textLines = blines.slice(tsLineIdx + 1);
    if (textLines.length === 0) continue;
    const text = textLines.join("\n").trim();

    const vttBlock = `${toVttTimestamp(startMs)} --> ${toVttTimestamp(
      endMs
    )}\n${text}`;
    vttBlocks.push(vttBlock);
  }

  return "WEBVTT\n\n" + vttBlocks.join("\n\n").trim();
}

/**
 * VTT → SRT
 *
 * 与 SRT→VTT 相反：
 *  - 去掉 "WEBVTT" 文件头
 *  - 时间戳分隔符从点号改为逗号
 *  - 为每个块添加递增序号
 *  - 开始/结束时间完整保留
 */
function convertVTTtoSRT(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  const withoutHeader = normalized.replace(/^WEBVTT[^\n]*\n+/, "");
  const blocks = withoutHeader.split(/\n\s*\n+/);
  const srtBlocks: string[] = [];
  let index = 1;

  for (const block of blocks) {
    const blines = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (blines.length === 0) continue;

    let tsLineIdx = blines.findIndex(
      (l) => l.includes("-->") && /\d{2}:\d{2}\.\d{3}/.test(l)
    );
    if (tsLineIdx === -1) continue;

    const ts = blines[tsLineIdx];
    const m = ts.match(
      /(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})/
    );
    if (!m) continue;
    const startMs = parseVttTimestamp(m[0].split("-->")[0].trim());
    const endMs = parseVttTimestamp(m[0].split("-->")[1].trim());

    const textLines = blines.slice(tsLineIdx + 1);
    if (textLines.length === 0) continue;
    const text = textLines.join("\n").trim();

    // SRT 每个块需要一个递增序号
    const srtBlock = `${index}\n${toSrtTimestamp(startMs)} --> ${toSrtTimestamp(
      endMs
    )}\n${text}`;
    srtBlocks.push(srtBlock);
    index++;
  }

  return srtBlocks.join("\n\n").trim();
}

/**
 * 字幕格式转换的统一入口（路由函数）。
 *
 * 根据 from/to 组合分发到对应的转换函数，并推导输出文件名。
 * 不支持 from === to（同格式不需要转换）。
 */
export function convertSubtitle(params: ConvertParams): ConvertResult {
  const { fileName, fileContent, from, to, defaultDurationMs, stripMediaExt } =
    params;
  let outputContent = "";
  let outputExt = "";

  if (from === "LRC" && to === "SRT") {
    outputContent = convertLRCtoSRT(fileContent, defaultDurationMs);
    outputExt = ".srt";
  } else if (from === "LRC" && to === "VTT") {
    outputContent = convertLRCtoVTT(fileContent, defaultDurationMs);
    outputExt = ".vtt";
  } else if (from === "SRT" && to === "LRC") {
    outputContent = convertSRTtoLRC(fileContent);
    outputExt = ".lrc";
  } else if (from === "SRT" && to === "VTT") {
    outputContent = convertSRTtoVTT(fileContent);
    outputExt = ".vtt";
  } else if (from === "VTT" && to === "LRC") {
    outputContent = convertVTTtoLRC(fileContent);
    outputExt = ".lrc";
  } else if (from === "VTT" && to === "SRT") {
    outputContent = convertVTTtoSRT(fileContent);
    outputExt = ".srt";
  } else {
    throw new Error(`Unsupported conversion: ${from} -> ${to}`);
  }

  const outputBaseName = getOutputBaseName(fileName, stripMediaExt);
  const outputFileName = `${outputBaseName}${outputExt}`;
  return { outputFileName, outputContent };
}
