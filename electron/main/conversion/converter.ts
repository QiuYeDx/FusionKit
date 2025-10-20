import path from "path";

export type ConvertParams = {
  fileName: string;
  fileContent: string;
  from: "LRC" | "SRT" | "VTT";
  to: "LRC" | "SRT" | "VTT";
  defaultDurationMs?: number; // for LRC->SRT/VTT last line or gaps
};

export type ConvertResult = {
  outputFileName: string;
  outputContent: string;
};

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function toSrtTimestamp(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = Math.max(0, Math.floor(ms % 1000));
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)},${millis
    .toString()
    .padStart(3, "0")}`;
}

function toVttTimestamp(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = Math.max(0, Math.floor(ms % 1000));
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}.${millis
    .toString()
    .padStart(3, "0")}`;
}

function parseSrtTimestamp(ts: string): number {
  // HH:MM:SS,mmm
  const m = ts.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
  if (!m) return 0;
  const [_, hh, mm, ss, mmm] = m;
  const hours = parseInt(hh, 10);
  const minutes = parseInt(mm, 10);
  const seconds = parseInt(ss, 10);
  const millis = parseInt(mmm, 10);
  return hours * 3600000 + minutes * 60000 + seconds * 1000 + millis;
}

function parseVttTimestamp(ts: string): number {
  // HH:MM:SS.mmm or MM:SS.mmm
  const m = ts.match(/(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})/);
  if (!m) return 0;
  const [_, hh, mm, ss, mmm] = m;
  const hours = hh ? parseInt(hh, 10) : 0;
  const minutes = parseInt(mm, 10);
  const seconds = parseInt(ss, 10);
  const millis = parseInt(mmm, 10);
  return hours * 3600000 + minutes * 60000 + seconds * 1000 + millis;
}

function toLrcTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hundredths = Math.round((ms % 1000) / 10);
  return `[${pad2(minutes)}:${pad2(seconds)}.${pad2(
    Math.min(99, hundredths)
  )}]`;
}

function convertLRCtoSRT(
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

  // 将相同时间戳的文本合并为同一块（多行）
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
    const end = Math.max(start + 300, endCandidate); // 至少300ms

    // 去重并拼接多语言行
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

  // 将相同时间戳的文本合并为同一块（多行）
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
    const end = Math.max(start + 300, endCandidate); // 至少300ms

    // 去重并拼接多语言行
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

  return "WEBVTT\n\n" + blocks.join("\n").trim();
}

function convertSRTtoLRC(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  const blocks = normalized.split(/\n\s*\n+/);
  const lines: string[] = [];

  for (const block of blocks) {
    const blines = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (blines.length === 0) continue;

    // Find timestamp line
    let tsLineIdx = blines.findIndex(
      (l) => l.includes("-->") && /\d{2}:\d{2}:\d{2},\d{3}/.test(l)
    );
    if (tsLineIdx === -1) {
      // maybe first line is index
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
    const startMs = parseSrtTimestamp(m[1]);

    const textLines = blines.slice(tsLineIdx + 1);
    if (textLines.length === 0) continue;
    const text = textLines.join(" ").trim();

    lines.push(`${toLrcTimestamp(startMs)}${text}`);
  }

  return lines.join("\n").trim();
}

function convertVTTtoLRC(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  // Remove WEBVTT header
  const withoutHeader = normalized.replace(/^WEBVTT[^\n]*\n+/, "");
  const blocks = withoutHeader.split(/\n\s*\n+/);
  const lines: string[] = [];

  for (const block of blocks) {
    const blines = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (blines.length === 0) continue;

    // Find timestamp line (VTT uses dots instead of commas)
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

    // Find timestamp line
    let tsLineIdx = blines.findIndex(
      (l) => l.includes("-->") && /\d{2}:\d{2}:\d{2},\d{3}/.test(l)
    );
    if (tsLineIdx === -1) {
      // maybe first line is index
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

function convertVTTtoSRT(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  // Remove WEBVTT header
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

    // Find timestamp line
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

    const srtBlock = `${index}\n${toSrtTimestamp(startMs)} --> ${toSrtTimestamp(
      endMs
    )}\n${text}`;
    srtBlocks.push(srtBlock);
    index++;
  }

  return srtBlocks.join("\n\n").trim();
}

export function convertSubtitle(params: ConvertParams): ConvertResult {
  const { fileName, fileContent, from, to, defaultDurationMs } = params;
  const parsed = path.parse(fileName);
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

  const outputFileName = `${parsed.name}${outputExt}`;
  return { outputFileName, outputContent };
}
