// Maintenance-only paired replay. Never imported by application/runtime code.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import * as esbuild from 'esbuild';
import { createTranscriptExecutorPlan, applyTranscriptExecutorPlan } from '../../scripts/subtitle-studio-provenance/transcript-executor-copy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helper = 'test/subtitle-studio/transcription/productionExecutor.test.ts';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const write = async (file, bytes) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); };
function applyEdits(text, edits) {
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}
function extractHelper(source, derived) {
  const ast = ts.createSourceFile(helper, source, ts.ScriptTarget.Latest, true);
  const edits = [], hooks = [];
  for (const statement of ast.statements) {
    if (ts.isExpressionStatement(statement)) {
      const call = statement.expression;
      const name = ts.isCallExpression(call) && ts.isIdentifier(call.expression) ? call.expression.text : null;
      if (!['describe', 'afterEach'].includes(name)) throw new Error('Unexpected T02 helper side effect');
      if (name === 'afterEach') hooks.push(call.arguments[0].getText(ast));
      edits.push({ start: statement.getStart(ast), end: statement.end, text: '' });
    } else if (ts.isImportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith('.')) continue;
      const target = path.resolve(root, path.dirname(helper), specifier);
      if (derived && specifier.endsWith('/native/production-executor')) {
        edits.push({ start: statement.getStart(ast), end: statement.end,
          text: `import { TranscriptionExecutor as LocalSubtitleProductionExecutor } from ${JSON.stringify(path.join(root, 'electron/main/subtitle-studio/transcription/transcript-executor.ts'))};` });
      } else edits.push({ start: statement.moduleSpecifier.getStart(ast), end: statement.moduleSpecifier.end, text: JSON.stringify(target) });
    }
  }
  if (hooks.length !== 1) throw new Error('T02 helper cleanup shape changed');
  let text = applyEdits(source, edits);
  // Expose the collaborator configuration so tests can verify default brand
  // rejection separately from the inherited deterministic response fixture.
  const start = '  const executor = new LocalSubtitleProductionExecutor({';
  const end = '  });\n  const admittedRuntimeGeneration =';
  if (text.split(start).length !== 2 || text.split(end).length !== 2) throw new Error('T02 helper executor construction changed');
  text = text.replace(start, '  const executorOptions = {').replace(end, '  };\n  const executor = new LocalSubtitleProductionExecutor(executorOptions);\n  const admittedRuntimeGeneration =');
  if (derived) {
    const collaborators = '    inputs,\n    outputs,\n    exporter,\n    verifyServerRuntime:';
    if (text.split(collaborators).length !== 2) throw new Error('T02 helper output collaborators changed');
    text = text.replace(collaborators, '    verifyServerRuntime:');
  }
  const returned = '  return {\n    root,\n    outputRoot,';
  if (text.split(returned).length !== 2) throw new Error('T02 helper return shape changed');
  text = text.replace(returned, '  return {\n    executorOptions,\n    root,\n    outputRoot,');
  return text + `\nexport { LocalSubtitleProductionExecutor as Executor, createHarness, rawSegment, serverResponse, validResponse, repeatedResponse, createAcceleratorFixture };\nexport const cleanup = ${hooks[0]};\n`;
}
function originalUrls(file, source) {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true), edits = [];
  function visit(node) {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'url' && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) edits.push({ start: node.getStart(ast), end: node.end, text: JSON.stringify(pathToFileURL(file).href) });
    else ts.forEachChild(node, visit);
  }
  visit(ast); return applyEdits(source, edits);
}
export async function createTranscriptExecutorReplay() {
  const plan = createTranscriptExecutorPlan({ root }); applyTranscriptExecutorPlan(plan, { root });
  const source = await fs.readFile(path.join(root, helper), 'utf8');
  const fork = JSON.parse(await fs.readFile(path.join(root, 'resources/subtitle-studio/provenance/transcription-fork.json'), 'utf8'));
  if (digest(source) !== fork.files.find(file => file.destinationPath === helper)?.destinationSha256) throw new Error('T02 replay helper hash differs');
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'studio-transcript-executor-replay-')));
  const apis = [], helperHashes = [], inputs = [];
  try {
    await fs.symlink(path.join(root, 'node_modules'), path.join(temporary, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const permitted = new Set(fork.files.map(file => path.join(root, file.destinationPath)));
    permitted.add(path.join(root, plan.files[0].destinationPath));
    for (const [name, derived] of [['t02', false], ['transcript', true]]) {
      const text = extractHelper(source, derived), entry = path.join(temporary, name + '.ts');
      helperHashes.push({ side: name, sha256: digest(text) }); await write(entry, text);
      const built = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', target: 'node20', metafile: true, logLevel: 'silent',
        plugins: [{ name: 'exact-t02-and-derived-closure', setup(build) {
          build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
            if (args.path !== entry && !permitted.has(args.path)) throw new Error(`Executor replay escaped declared sources: ${args.path}`);
            return { contents: originalUrls(args.path, await fs.readFile(args.path, 'utf8')), loader: args.path.endsWith('.ts') ? 'ts' : 'js' };
          });
        } }],
      });
      const output = path.join(temporary, name + '.mjs'); await write(output, built.outputFiles[0].contents);
      inputs.push({ side: name, paths: Object.keys(built.metafile.inputs).filter(file => path.resolve(file) !== entry).map(file => path.relative(root, path.resolve(file))).sort() });
      apis.push(await import(pathToFileURL(output).href));
    }
    return { t02: apis[0], transcript: apis[1], evidence: { helperPath: helper, helperSha256: digest(source), helperHashes, inputs, derivedSha256: digest(plan.files[0].bytes) },
      async cleanup() {
        const results = await Promise.allSettled(apis.map(api => api.cleanup()));
        const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
        try { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); } catch (error) { failures.push(error); }
        esbuild.stop(); if (failures.length) throw new AggregateError(failures, 'Transcript replay cleanup failed');
      },
    };
  } catch (error) { await Promise.allSettled(apis.map(api => api.cleanup())); await fs.rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); esbuild.stop(); throw error; }
}
