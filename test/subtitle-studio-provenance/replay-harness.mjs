// Migration-only verification. Studio runtime and ordinary tests must not import this file.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import * as esbuild from 'esbuild';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executorTest = 'test/local-subtitle/productionExecutor.test.ts';
const mediaTest = 'test/local-subtitle/mediaNormalizer.test.ts';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const slash = value => value.split(path.sep).join('/');

function frozenBlob(commit, sourcePath) {
  return execFileSync('git', ['-C', repositoryRoot, 'show', `${commit}:${sourcePath}`], { maxBuffer: 16 * 1024 * 1024 });
}

async function write(root, relativePath, bytes) {
  const output = path.join(root, relativePath);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, bytes);
}

function applyEdits(text, edits) {
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}

function resolveSource(from, specifier, files) {
  const base = specifier.startsWith('@/') ? `src/${specifier.slice(2)}` : path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const result = [base, ...['.ts', '.tsx', '.js', '.mjs', '.json', '/index.ts'].map(suffix => base + suffix)].find(candidate => files.has(candidate));
  if (!result) throw new Error(`Replay helper has an unregistered dependency: ${from} -> ${specifier}`);
  return result;
}

function moduleSpecifier(from, to) {
  const relative = path.posix.relative(path.posix.dirname(from), to);
  return relative.startsWith('.') ? relative : `./${relative}`;
}

/** Keep the frozen helper declarations, never execute its describe/it/hooks. */
function extractHarness(sourcePath, bytes, outputPath, destinationFor, sourceFiles, kind) {
  const text = bytes.toString('utf8');
  const ast = ts.createSourceFile(sourcePath, text, ts.ScriptTarget.Latest, true);
  const edits = [];
  const hooks = new Map();
  for (const statement of ast.statements) {
    if (ts.isExpressionStatement(statement)) {
      const call = statement.expression;
      const name = ts.isCallExpression(call) && ts.isIdentifier(call.expression) ? call.expression.text : null;
      if (!['describe', 'beforeEach', 'afterEach'].includes(name)) throw new Error(`Unexpected top-level replay statement in ${sourcePath}`);
      if (name !== 'describe') {
        if (hooks.has(name) || call.arguments.length !== 1 || !ts.isArrowFunction(call.arguments[0])) throw new Error(`Unrecognized ${name} fixture lifecycle`);
        hooks.set(name, call.arguments[0].getText(ast));
      }
      edits.push({ start: statement.getStart(ast), end: statement.end, text: '' });
    } else if (ts.isImportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier.text;
      if (specifier.startsWith('.') || specifier.startsWith('@/')) {
        const target = destinationFor(resolveSource(sourcePath, specifier, sourceFiles));
        edits.push({ start: statement.moduleSpecifier.getStart(ast), end: statement.moduleSpecifier.end, text: JSON.stringify(moduleSpecifier(outputPath, target)) });
      }
    } else if (![ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.VariableStatement].includes(statement.kind)) {
      throw new Error(`Unsupported frozen helper declaration in ${sourcePath}`);
    }
  }
  let extracted = applyEdits(text, edits);
  const exportFrom = (symbols, source) => `export { ${symbols} } from ${JSON.stringify(moduleSpecifier(outputPath, destinationFor(source)))};\n`;
  if (kind === 'executor') {
    if (!hooks.has('afterEach') || hooks.has('beforeEach')) throw new Error('Executor fixture lifecycle changed');
    extracted += '\nexport { createHarness, rawSegment, serverResponse, validResponse, repeatedResponse, createAcceleratorFixture };\n';
    extracted += `export const cleanup = ${hooks.get('afterEach')};\n`;
    extracted += exportFrom('isLocalSubtitleVerifiedBackendResolution', 'electron/main/local-subtitle/backend-resolver.ts');
    extracted += exportFrom('isLocalSubtitleVerifiedAcceleratorPack', 'electron/main/local-subtitle/accelerator-manager.ts');
    extracted += exportFrom('parseLocalSubtitleServerVerboseJson', 'electron/main/local-subtitle/server-contract.ts');
  } else {
    if (!hooks.has('beforeEach') || !hooks.has('afterEach')) throw new Error('Media fixture lifecycle changed');
    extracted += '\nexport { normalizedFixture, structuralWindow, OWNER_A, isLocalSubtitleNormalizedPcm, isLocalSubtitleBrandedPcmWindow };\n';
    extracted += `export const setup = ${hooks.get('beforeEach')};\nexport const cleanup = ${hooks.get('afterEach')};\n`;
  }
  return extracted;
}

function retainOriginalModuleUrls(name, text) {
  const ast = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const edits = [];
  const visit = node => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'url' && ts.isMetaProperty(node.expression)
      && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword && node.expression.name.text === 'meta') {
      edits.push({ start: node.getStart(ast), end: node.end, text: JSON.stringify(pathToFileURL(name).href) });
    } else ts.forEachChild(node, visit);
  };
  visit(ast);
  return applyEdits(text, edits);
}

async function bundleSide(sideRoot, executorPath, mediaPath) {
  const entryPath = path.join(sideRoot, '__migration-entry.ts');
  await fs.writeFile(entryPath, `export * as executor from ${JSON.stringify('./' + executorPath)};\nexport * as media from ${JSON.stringify('./' + mediaPath)};\n`);
  const result = await esbuild.build({
    absWorkingDir: sideRoot, entryPoints: [entryPath], bundle: true, write: false, platform: 'node', format: 'esm',
    target: 'node20', packages: 'external', metafile: true, logLevel: 'silent',
    plugins: [{ name: 'isolated-replay-sources', setup(build) {
      build.onResolve({ filter: /^@\// }, args => {
        const candidate = path.join(sideRoot, 'src', args.path.slice(2));
        const resolved = [candidate, candidate + '.ts', candidate + '.tsx', candidate + '.json', path.join(candidate, 'index.ts')].find(value => fsSync.existsSync(value));
        if (!resolved) throw new Error(`Frozen alias cannot resolve: ${args.path}`);
        return { path: resolved };
      });
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
        const relative = path.relative(sideRoot, args.path);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Replay escaped its isolated source tree: ${args.path}`);
        const text = await fs.readFile(args.path, 'utf8');
        return { contents: retainOriginalModuleUrls(args.path, text), loader: args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : 'js' };
      });
    } }],
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    const relative = path.relative(sideRoot, path.resolve(sideRoot, input));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Unexpected bundled application source: ${input}`);
  }
  const output = path.join(sideRoot, '__migration-replay.mjs');
  await fs.writeFile(output, result.outputFiles[0].contents);
  // Application imports and aliases have already been resolved inside this isolated bundle.
  return { api: await import(pathToFileURL(output).href), bundledInputs: Object.keys(result.metafile.inputs).map(slash).sort() };
}

export async function createReplayPair() {
  const { createCopyPlan } = await import('../../scripts/subtitle-studio-provenance/copy.mjs');
  const plan = await createCopyPlan({ root: repositoryRoot });
  const baseline = plan.baseline;
  const sourceFiles = new Map(baseline.files.map(file => [file.sourcePath, file]));
  const planned = new Map(plan.files.map(file => [file.sourcePath, file]));
  const tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'studio-transcription-replay-')));
  const legacyRoot = path.join(tempRoot, 'frozen-v1');
  const studioRoot = path.join(tempRoot, 'studio');
  const helperEvidence = [];
  try {
    // Dependency packages are shared; application source and fixture files are not.
    await fs.symlink(path.join(repositoryRoot, 'node_modules'), path.join(tempRoot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const file of plan.files) {
      const frozen = frozenBlob(baseline.sourceCommit, file.sourcePath);
      if (digest(frozen) !== sourceFiles.get(file.sourcePath)?.sha256) throw new Error(`Frozen replay source digest differs: ${file.sourcePath}`);
      const actual = await fs.readFile(path.join(repositoryRoot, file.destinationPath));
      if (digest(actual) !== digest(file.bytes)) throw new Error(`Studio replay source differs from mechanical copy: ${file.destinationPath}`);
      await write(legacyRoot, file.sourcePath, frozen);
      await write(studioRoot, file.destinationPath, actual);
    }
    for (const [sideRoot, current] of [[legacyRoot, false], [studioRoot, true]]) {
      const destinationFor = sourcePath => {
        if (!current) return sourcePath;
        const destination = planned.get(sourcePath)?.destinationPath;
        if (!destination) throw new Error(`Replay requires an uncopied source: ${sourcePath}`);
        return destination;
      };
      for (const [sourcePath, kind] of [[executorTest, 'executor'], [mediaTest, 'media']]) {
        const bytes = frozenBlob(baseline.sourceCommit, sourcePath);
        const record = sourceFiles.get(sourcePath);
        if (!record || digest(bytes) !== record.sha256) throw new Error(`Frozen test helper digest differs: ${sourcePath}`);
        const outputPath = current ? `test/subtitle-studio/transcription/__${kind}-migration-harness.ts` : `test/local-subtitle/__${kind}-migration-harness.ts`;
        const helper = extractHarness(sourcePath, bytes, outputPath, destinationFor, sourceFiles, kind);
        await write(sideRoot, outputPath, helper);
        helperEvidence.push({ side: current ? 'studio' : 'frozen-v1', sourcePath, sourceSha256: digest(bytes), extractedSha256: digest(helper) });
      }
    }
    const legacy = await bundleSide(legacyRoot, 'test/local-subtitle/__executor-migration-harness.ts', 'test/local-subtitle/__media-migration-harness.ts');
    const studio = await bundleSide(studioRoot, 'test/subtitle-studio/transcription/__executor-migration-harness.ts', 'test/subtitle-studio/transcription/__media-migration-harness.ts');
    return {
      legacy: legacy.api, studio: studio.api,
      evidence: { sourceCommit: baseline.sourceCommit, copiedFiles: plan.files.length, helperEvidence, legacyInputs: legacy.bundledInputs, studioInputs: studio.bundledInputs },
      async cleanup() {
        const results = await Promise.allSettled([legacy.api.executor.cleanup(), studio.api.executor.cleanup()]);
        const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
        try { await fs.rm(tempRoot, { recursive: true, force: true }); } catch (error) { failures.push(error); }
        finally { esbuild.stop(); }
        if (failures.length) throw new AggregateError(failures, 'Replay fixture cleanup failed');
      },
    };
  } catch (error) {
    try { await fs.rm(tempRoot, { recursive: true, force: true }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Replay initialization and cleanup failed'); }
    finally { esbuild.stop(); }
    throw error;
  }
}

const requestProjection = request => {
  const { filePath, signal, ...semantic } = request;
  return { ...semantic, windowFile: path.basename(filePath), aborted: signal?.aborted ?? false };
};

export async function runReplayCase(api, scenario) {
  const rawResponses = [];
  const accelerator = scenario.accelerator ? await api.createAcceleratorFixture() : null;
  let harness;
  try {
    harness = await api.createHarness({ ...scenario.options, ...(accelerator ? { acceleratorPack: accelerator.proof } : {}),
      inference: input => {
        const response = scenario.inference(api, input);
        rawResponses.push(structuredClone(response));
        return response;
      },
    });
    if (scenario.quietCandidates) harness.media.readQuietCandidates.mockResolvedValue(structuredClone(scenario.quietCandidates));
    const outcome = await harness.executor.execute(harness.context);
    harness.executor.endBatchSlice(harness.context.batchRuntime);
    const transcript = harness.exporter.exportArtifacts.mock.calls[0]?.[0].transcript ?? null;
    const requests = harness.supervisor.beginInference.mock.calls.map(([, request]) => requestProjection(request));
    const windows = harness.media.materializeWindow.mock.calls.map(([request]) => ({ descriptor: structuredClone(request.descriptor), conditioned: request.conditionQuietAudio === true }));
    const lifecycle = [];
    const track = (name, mock) => mock.mock.invocationCallOrder.forEach((order, index) => lifecycle.push({ order, name,
      ...(name === 'infer' ? { generation: mock.mock.calls[index][1].requestGeneration } : {}),
      ...(name === 'window' ? { windowKey: mock.mock.calls[index][0].descriptor.windowKey } : {}),
    }));
    track('scan', harness.media.readQuietCandidates);
    track('window', harness.media.materializeWindow);
    track('infer', harness.supervisor.beginInference);
    track('dispose-window', harness.media.disposeWindow);
    track('acquire-pin', harness.supervisor.acquireBatchRuntimePin);
    track('task-lease', harness.supervisor.acquirePinnedTaskLease);
    track('separator-lease', harness.supervisor.acquirePinnedSeparatorLease);
    track('release-lease', harness.supervisor.release);
    track('dispose-normalized', harness.media.disposeNormalized);
    track('export', harness.exporter.exportArtifacts);
    track('release-pin', harness.supervisor.releaseBatchRuntimePin);
    lifecycle.sort((a, b) => a.order - b.order);
    return {
      id: scenario.id, status: outcome.status, errorCode: outcome.error?.code ?? null, error: structuredClone(outcome.error ?? null),
      cueSummary: structuredClone(outcome.cueSummary ?? null), durationMs: outcome.durationMs ?? null,
      config: structuredClone(harness.context.config),
      transcript: structuredClone(transcript), rawResponses, requests, windows,
      updates: harness.context.update.mock.calls.map(([update]) => structuredClone(update)),
      lifecycle: lifecycle.map(({ order, ...event }) => event),
      taskLeaseOptions: harness.supervisor.acquirePinnedTaskLease.mock.calls.map(call => call[2]),
      separatorLeaseOptions: harness.supervisor.acquirePinnedSeparatorLease.mock.calls.map(call => call[2]),
      artifacts: outcome.artifactResults.map(result => ({ format: result.format, status: result.status,
        ...(result.status === 'committed' ? { sha256: result.artifact.sha256, byteSize: result.artifact.byteSize } : {}),
      })),
    };
  } finally {
    const failures = [];
    try { if (harness) harness.executor.endBatchSlice(harness.context.batchRuntime); } catch (error) { failures.push(error); }
    try { await accelerator?.cleanup(); } catch (error) { failures.push(error); }
    try { await api.cleanup(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Replay case cleanup failed');
  }
}

export async function saveReplayEvidence(evidence) {
  await write(repositoryRoot, 'test-results/studio-transcription-replay/evidence.json', JSON.stringify(evidence, null, 2) + '\n');
}
