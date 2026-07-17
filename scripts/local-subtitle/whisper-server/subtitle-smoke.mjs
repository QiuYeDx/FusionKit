export function createSmokeCues(segments) {
  return segments.flatMap((segment) => {
    const text = String(segment?.text ?? "")
      .replace(/\r\n?|\n/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    if (
      !text ||
      !Number.isInteger(segment?.startMs) ||
      !Number.isInteger(segment?.endMs) ||
      segment.startMs < 0 ||
      segment.endMs <= segment.startMs
    ) {
      return [];
    }
    return [{ startMs: segment.startMs, endMs: segment.endMs, text }];
  });
}

export function formatSmokeSrt(cues) {
  return `${cues
    .map(
      (cue, index) =>
        `${index + 1}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\n${cue.text}`,
    )
    .join("\n\n")}\n`;
}

export function parseSmokeSrt(value) {
  const normalized = String(value).replace(/\r\n?/gu, "\n").trim();
  if (!normalized) return [];
  return normalized.split(/\n{2,}/u).map((block, index) => {
    const lines = block.split("\n");
    if (Number(lines[0]) !== index + 1 || lines.length < 3) {
      throw new Error(`Invalid SRT block at index ${index}.`);
    }
    const match = lines[1].match(
      /^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})$/u,
    );
    if (!match) throw new Error(`Invalid SRT timestamp at index ${index}.`);
    return {
      startMs: parseSrtTime(match.slice(1, 5)),
      endMs: parseSrtTime(match.slice(5, 9)),
      text: lines.slice(2).join("\n"),
    };
  });
}

export function formatSmokeLrc(cues) {
  return `${cues
    .map((cue) => `[${formatLrcTime(cue.startMs)}]${cue.text}`)
    .join("\n")}\n`;
}

export function parseSmokeLrc(value) {
  const normalized = String(value).replace(/\r\n?/gu, "\n").trim();
  if (!normalized) return [];
  return normalized.split("\n").map((line, index) => {
    const match = line.match(/^\[(\d+):(\d{2})\.(\d{2})\](.*)$/u);
    if (!match) throw new Error(`Invalid LRC line at index ${index}.`);
    return {
      startCentiseconds:
        (Number(match[1]) * 60 + Number(match[2])) * 100 + Number(match[3]),
      text: match[4],
    };
  });
}

export function verifySmokeSrtRoundTrip(cues, value) {
  const parsed = parseSmokeSrt(value);
  return parsed.length === cues.length && parsed.every((cue, index) =>
    cue.startMs === cues[index].startMs &&
    cue.endMs === cues[index].endMs &&
    cue.text === cues[index].text
  );
}

export function verifySmokeLrcRoundTrip(cues, value) {
  const parsed = parseSmokeLrc(value);
  return parsed.length === cues.length && parsed.every((cue, index) =>
    cue.startCentiseconds === Math.floor(cues[index].startMs / 10) &&
    cue.text === cues[index].text
  );
}

function formatSrtTime(milliseconds) {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":") + `,${String(millis).padStart(3, "0")}`;
}

function parseSrtTime(parts) {
  const [hours, minutes, seconds, millis] = parts.map(Number);
  return ((hours * 60 + minutes) * 60 + seconds) * 1_000 + millis;
}

function formatLrcTime(milliseconds) {
  const centiseconds = Math.floor(milliseconds / 10);
  const minutes = Math.floor(centiseconds / 6_000);
  const seconds = Math.floor((centiseconds % 6_000) / 100);
  const remainder = centiseconds % 100;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(remainder).padStart(2, "0")}`;
}
