/** Offline proposals remain unaccepted even though the shared rule has a production consumer. */
import { readFile } from "node:fs/promises";
import ts from "typescript";
const sourceUrl = new URL("../../../electron/main/local-subtitle/cue-prefix-overlap-evidence.ts", import.meta.url);
const compiled = ts.transpileModule(await readFile(sourceUrl, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { inspectPrefixOverlapTiming } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
export function auditPrefixOverlapTiming(source, views) {
  if (!source || !/^[a-f0-9]{64}$/u.test(source.mediaSha256 ?? ""))
    return { automaticAcceptance: false, status: "rejected", reason: "invalid_input", observations: [] };
  const result = inspectPrefixOverlapTiming({ ...source, sourceIdentity: source.mediaSha256 },
    Array.isArray(views) ? views.map(v => ({ ...v, sourceIdentity: v?.mediaSha256 })) : views);
  if (result.status === "rejected") return { automaticAcceptance: false, ...result };
  const { sourceIdentity, status: _status, ...evidence } = result;
  return { automaticAcceptance: false, status: "listening_candidate", mediaSha256: sourceIdentity, ...evidence };
}
