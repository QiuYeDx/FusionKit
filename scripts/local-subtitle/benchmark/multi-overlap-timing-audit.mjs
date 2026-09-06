/** Shared production evidence, exposed for offline qualification without automatic acceptance. */
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = new URL('../../../electron/main/local-subtitle/cue-multi-overlap-evidence.ts', import.meta.url);
const compiled = ts.transpileModule(await readFile(source, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { inspectMultiOverlapTiming } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
export function auditMultiOverlapTiming(source, views) {
  if (!source || !/^[a-f0-9]{64}$/u.test(source.mediaSha256 ?? '')) return { automaticAcceptance: false, status: 'rejected', reason: 'invalid_media' };
  return { automaticAcceptance: false, ...inspectMultiOverlapTiming({ ...source, sourceIdentity: source.mediaSha256 },
    Array.isArray(views) ? views.map(v => ({ ...v, sourceIdentity: v?.mediaSha256 })) : views) };
}
