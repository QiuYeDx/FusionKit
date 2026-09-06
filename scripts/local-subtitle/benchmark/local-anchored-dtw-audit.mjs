/** Offline multi-view audit; source words are never replaced. */
import { readFile } from "node:fs/promises";
import ts from "typescript";
// Keep the offline runner compatible with the project's Node >=18 contract.
// Production bundles the same TS source normally; no generated copy is committed.
const sourceUrl = new URL("../../../electron/main/local-subtitle/cue-local-anchor-evidence.ts", import.meta.url);
const compiled = ts.transpileModule(await readFile(sourceUrl, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { inspectLocalAnchorEvidence } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
function inspect(source, view) {
  if (!view || view.mode !== "uncompressed_non_vad" || view.mediaSha256 !== source.mediaSha256 || !Array.isArray(view.segments))
    return { id: view?.id, reasons: ["invalid_provenance"], boundaries: [] };
  const ms = value => typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1000) : NaN;
  return inspectLocalAnchorEvidence(source, { ...view, segments: view.segments.map(segment => ({
    text: segment?.text, startMs: ms(segment?.start), endMs: ms(segment?.end),
    dtwTokens: Array.isArray(segment?.words) ? segment.words.map(word => ({ text: word?.word,
      pointMs: Number.isSafeInteger(word?.t_dtw) ? word.t_dtw * 10 : null })) : undefined,
  })) });
}

export function auditLocalAnchoredDtwBoundaries(source, observations) {
  if (!source || typeof source.text !== "string" || !source.text || source.text.length > 4096 ||
      /[\r\n「」『』“”"'‘’（）()【】\[\]{}〈〉《》]/u.test(source.text) ||
      !/^[a-f0-9]{64}$/u.test(source.mediaSha256 ?? "") ||
      !Number.isSafeInteger(source.startMs) || source.startMs < 0 ||
      !Number.isSafeInteger(source.endMs) || source.endMs <= source.startMs ||
      !Array.isArray(observations) || observations.length < 2 || observations.length > 8 ||
      observations.some(v => typeof v?.id !== "string" || !v.id)) throw new Error("invalid_audit_input");
  const reviewed = observations.map(view => inspect(source, view));
  const duplicates = new Set(observations.map(v => v.id)).size !== observations.length ||
    new Set(observations.map(v => `${v.windowStartMs}:${v.windowEndMs}`)).size !== observations.length;
  const proposals = [], rejected = [];
  for (const reference of reviewed[0].boundaries) {
    const votes = observations.map((view, index) => {
      const context = view.windowStartMs <= reference.anchorStartMs - 300 && view.windowEndMs >= reference.anchorEndMs + 300;
      const matches = reviewed[index].boundaries.filter(b => b.offset === reference.offset);
      return { id: view.id, context, reasons: !context ? ["insufficient_audio_context"] :
        reviewed[index].reasons.length ? reviewed[index].reasons : matches.length !== 1 ? ["missing_or_ambiguous_boundary"] : [],
        boundary: context && matches.length === 1 ? matches[0] : null };
    });
    const eligible = votes.filter(v => v.context), points = eligible.flatMap(v => v.boundary ? [v.boundary] : []);
    const spread = Object.fromEntries(["leftPointMs", "rightPointMs"].map(key => [key,
      points.length ? Math.max(...points.map(p => p[key])) - Math.min(...points.map(p => p[key])) : null]));
    const reasons = [];
    if (duplicates) reasons.push("duplicate_observation");
    if (!votes[0].context || eligible.length < 2 || new Set(observations.filter((_, i) => votes[i].context).map(v => v.windowStartMs)).size < 2)
      reasons.push("insufficient_shifted_support");
    if (reviewed.some(v => v.reasons.length) || eligible.some(v => v.reasons.length)) reasons.push("invalid_observation");
    if (Object.values(spread).some(value => value !== null && value > 300)) reasons.push("window_disagreement");
    const item = { offset: reference.offset, candidateMs: reference.rightPointMs, spread, reasons, votes };
    (reasons.length ? rejected : proposals).push(item);
  }
  return { automaticAcceptance: false, semantics: "token_interior_points_not_speech_edges", observations: reviewed, proposals, rejected };
}
