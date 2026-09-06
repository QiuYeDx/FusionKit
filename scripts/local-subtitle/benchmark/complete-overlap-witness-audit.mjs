/** Offline listening proposals only; never authorizes production text deletion. */
import { readFile } from "node:fs/promises";
import ts from "typescript";
const sourceUrl = new URL("../../../electron/main/local-subtitle/cue-complete-overlap-evidence.ts", import.meta.url);
const compiled = ts.transpileModule(await readFile(sourceUrl, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { inspectCompleteOverlapWitness } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

export function auditCompleteOverlapWitness({ mediaSha256, review, rightWindowStartMs, candidate } = {}) {
  if (!/^[a-f0-9]{64}$/u.test(mediaSha256 ?? ""))
    return { automaticAcceptance: false, status: "rejected", reason: "invalid_input" };
  const result = inspectCompleteOverlapWitness({ review, rightWindowStartMs, candidate });
  if (!result.supported) return { automaticAcceptance: false, status: "rejected", reason: result.reason };
  return { automaticAcceptance: false, status: "listening_candidate", mediaSha256,
    replacement: result.replacement,
    evidence: { ...result.evidence, requiredHumanChecks: ["no_lost_speech_or_real_repeat", "complete_phrase_onset"] } };
}
