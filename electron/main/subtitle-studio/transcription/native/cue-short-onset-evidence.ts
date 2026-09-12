import type { LocalSubtitleSegment } from "../../../../../src/subtitle-studio/transcription/domain";

export interface ShortOnsetAudio { sourceIdentity: string; originMs: number; samples: Int16Array; }
export interface ShortOnsetView {
  id: string; sourceIdentity: string; originMs: number; durationMs: number;
  segments: readonly { text: string; startMs: number; endMs: number;
    dtwTokens?: readonly { text: string; pointMs: number | null }[] }[];
}
export interface ShortOnsetSource {
  sourceIdentity: string; cue: LocalSubtitleSegment; following: readonly LocalSubtitleSegment[];
}
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const words = new Intl.Segmenter("ja", { granularity: "word" });
const units = (text: string) => Array.from(segmenter.segment(text), item => item.segment)
  .filter(g => !/^[、。！？!?，,；;：:\s]+$/u.test(g));
const safeTime = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const quote = /[「」『』“”"'‘’（）()【】\[\]{}〈〉《》]/u;
const occurrences = (text: string[], part: string[]) => text.flatMap((_, i) => i + part.length <= text.length && part.every((g, j) => g === text[i + j]) ? [i] : []);
const reject = (reason: string) => ({ status: "rejected" as const, reason });

/** Activity is only a timing constraint. It is never classified as speech or a word edge. */
export function inspectShortOnsetActivity(audio: ShortOnsetAudio) {
  if (typeof audio?.sourceIdentity !== "string" || !audio.sourceIdentity || audio.sourceIdentity.length > 256 || !safeTime(audio.originMs) ||
      !(audio.samples instanceof Int16Array) || audio.samples.length < 16000 || audio.samples.length > 480000 ||
      !Number.isSafeInteger(audio.originMs + Math.ceil(audio.samples.length / 16))) return reject("invalid_audio");
  const rms: number[] = [];
  for (let i = 0; i < audio.samples.length; i += 160) {
    let sum = 0;const end = Math.min(i + 160, audio.samples.length);
    for (let j = i; j < end; j++) sum += (audio.samples[j] / 32768) ** 2;
    rms.push(Math.sqrt(sum / (end - i)));
  }
  const ordered = [...rms].sort((a, b) => a - b), peak = ordered.at(-1)!;
  const threshold = Math.max(ordered[Math.floor((ordered.length - 1) * .2)] * 4, peak * .03, 2 / 32768);
  const runs: { startMs: number; endMs: number }[] = [];
  for (let i = 0; i < rms.length; i++) {
    if (rms[i] < threshold) continue;
    const start = i;while (i + 1 < rms.length && rms[i + 1] >= threshold) i++;
    const startMs = audio.originMs + start * 10, endMs = audio.originMs + Math.min((i + 1) * 10, audio.samples.length / 16);
    if (endMs - startMs >= 40) runs.push({ startMs, endMs });
  }
  const events: { startMs: number; endMs: number }[] = [];
  for (const run of runs) {const last = events.at(-1);if (last && run.startMs - last.endMs <= 160) last.endMs = run.endMs;else events.push({ ...run });}
  return { status: "activity" as const, sourceIdentity: audio.sourceIdentity, originMs: audio.originMs,
    endMs: audio.originMs + audio.samples.length / 16, threshold, events };
}

export function inspectShortOnsetSource(source: ShortOnsetSource) {
  const validCue = (c: LocalSubtitleSegment) => c && typeof c.text === "string" && c.text.length > 0 && c.text.length <= 1024 &&
    !quote.test(c.text) && safeTime(c.startMs) && safeTime(c.endMs) && c.endMs > c.startMs;
  if (typeof source?.sourceIdentity !== "string" || !source.sourceIdentity || source.sourceIdentity.length > 256 || !validCue(source.cue) ||
      !Array.isArray(source.following) || source.following.length < 1 || source.following.length > 4 || !source.following.every(validCue)) return reject("invalid_source");
  const match = /^(\S(?:[^\r\n]*\S)?)\s+(\S+)$/u.exec(source.cue.text);
  if (!match || units(match[1]).length < 4 || units(match[2]).length < 2 || units(match[2]).length > 12 || /^(?:です|ます|でした|ました|ない)$/u.test(match[2])) return reject("no_short_source_suffix");
  const target = match[2], offset = source.cue.text.length - target.length;
  if (!Array.from(words.segment(source.cue.text)).some(w => w.index === offset && w.isWordLike)) return reject("unsafe_source_word");
  if (source.following.some((c, i) => c.startMs !== (i ? source.following[i - 1].endMs : source.cue.endMs))) return reject("discontinuous_source");
  const forward = source.following.map(c => c.text).join(""), n = units(forward).length;
  if (n < 12 || n > 64) return reject("insufficient_forward_context");
  const full = units(target + forward), context = units(source.cue.text + forward);
  if (occurrences(context, full).length !== 1 || occurrences(context, units(target)).length !== 1) return reject("ambiguous_source");
  return { status: "short_source" as const, prefix: match[1], target, targetUnits: units(target), full };
}

export function inspectShortOnsetView(source: ShortOnsetSource, audio: ShortOnsetAudio, view: ShortOnsetView) {
  const s = inspectShortOnsetSource(source);if (s.status === "rejected") return s;
  const activity = inspectShortOnsetActivity(audio);if (activity.status === "rejected") return activity;
  if (typeof view?.id !== "string" || !view.id || view.id.length > 256 || view.sourceIdentity !== source.sourceIdentity || audio.sourceIdentity !== source.sourceIdentity ||
      !Number.isSafeInteger(view.originMs) || view.originMs < -30000 || !safeTime(view.durationMs) || view.durationMs < 1000 || view.durationMs > 30000 ||
      !Array.isArray(view.segments) || !view.segments.length || view.segments.length > 128 || view.segments.some(p => typeof p?.text !== "string" || !p.text || quote.test(p.text)) ||
      view.segments.reduce((n, p) => n + p.text.length, 0) > 8192) return reject("invalid_view");
  const full = units(view.segments.map(p => p.text).join("")), tokens: { text: string; from: number; to: number; pointMs: number }[] = [];
  let cursor = 0, previousEnd = 0, previousPoint = -1, count = 0;
  for (const p of view.segments) {
    if (!safeTime(p.startMs) || !safeTime(p.endMs) || p.startMs < previousEnd || p.endMs <= p.startMs || p.endMs > view.durationMs ||
        !Array.isArray(p.dtwTokens) || (count += p.dtwTokens.length) > 4096 || p.dtwTokens.some((t: { text: string }) => typeof t?.text !== "string") ||
        p.dtwTokens.map((t: { text: string }) => t.text).join("") !== p.text) return reject("invalid_token_coverage");
    previousEnd = p.endMs;
    for (const token of p.dtwTokens) {
      const n = units(token.text).length;if (!n) continue;
      if (!safeTime(token.pointMs) || token.pointMs < previousPoint || token.pointMs > view.durationMs) return reject("invalid_token_points");
      previousPoint = token.pointMs;tokens.push({ text: token.text, from: cursor, to: cursor + n, pointMs: view.originMs + token.pointMs });cursor += n;
    }
  }
  if (cursor !== full.length) return reject("grapheme_coverage");
  const positions = occurrences(full, s.full);
  if (positions.length !== 1 || occurrences(full, s.targetUnits).length !== 1) return reject("no_unique_complete_forward_match");
  const from = positions[0], cut = from + s.targetUnits.length, to = from + s.full.length;
  const matched = tokens.filter(t => t.from >= from && t.to <= to), target = matched.filter(t => t.to <= cut);
  if (target.length < 2 || target[0].from !== from || target.at(-1)!.to !== cut || matched.at(-1)?.to !== to ||
      !matched.some(t => t.from === cut)) return reject("partial_target_or_context_token");
  if (matched.some(t => t.pointMs < source.cue.startMs || t.pointMs > source.following.at(-1)!.endMs + 400)) return reject("source_point_bounds");
  const first = target[0].pointMs, last = target.at(-1)!.pointMs;
  const possible = activity.events.filter(e => target.every(t => t.pointMs >= e.startMs - 40 && t.pointMs <= e.endMs + 40));
  if (possible.length !== 1) return { ...reject("target_points_not_in_one_activity"), targetPoints: target.map(t => t.pointMs), activity };
  const event = possible[0], prior = activity.events[activity.events.indexOf(event) - 1], gap = event.startMs - (prior?.endMs ?? activity.originMs);
  if (event.endMs - event.startMs < 200 || event.endMs - event.startMs > 4000 || first - event.startMs > 500 || gap < 300 ||
      last <= first || first - source.cue.startMs < 600 || source.cue.endMs - first < 600 || source.cue.endMs - first > 8000) return reject("unseparated_or_unsafe_activity");
  return { status: "short_onset_supported" as const, id: view.id, pointMs: first, lastPointMs: last, event, gapMs: gap,
    targetTokens: target, originalText: view.segments.map(p => p.text).join(""), activity };
}

/** All supplied observations participate; a rejection is never silently dropped. */
export function inspectShortOnsetConsensus(source: ShortOnsetSource, audio: ShortOnsetAudio, views: readonly ShortOnsetView[]) {
  if (!Array.isArray(views) || views.length < 2 || views.length > 8 || new Set(views.map(v => v?.id)).size !== views.length ||
      new Set(views.map(v => `${v?.originMs}:${v?.durationMs}`)).size !== views.length) return reject("distinct_observations_required");
  const observations = views.map(v => inspectShortOnsetView(source, audio, v));
  const valid = observations.flatMap(v => v.status === "short_onset_supported" ? [v] : []);
  if (valid.length !== observations.length) return { ...reject("unsupported_observation"), observations };
  if (Math.max(...valid.map(v => v.pointMs)) - Math.min(...valid.map(v => v.pointMs)) > 300 ||
      Math.max(...valid.map(v => v.lastPointMs)) - Math.min(...valid.map(v => v.lastPointMs)) > 300 ||
      valid.some(v => v.event.startMs !== valid[0].event.startMs || v.event.endMs !== valid[0].event.endMs)) return { ...reject("inconsistent_onset"), observations };
  const s = inspectShortOnsetSource(source);if (s.status === "rejected") return s;
  return { status: "supported" as const, observations, replacements: [
    { ...source.cue, text: s.prefix, endMs: valid[0].pointMs },
    { ...source.cue, id: source.cue.id + "-short", text: s.target, startMs: valid[0].pointMs },
  ] };
}
