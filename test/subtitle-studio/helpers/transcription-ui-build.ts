import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as esbuild from 'esbuild';

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Mirrors the production build. Only the controlled run substitutes one exact native module. */
export async function buildTranscriptionUiApp(mode: 'controlled' | 'actual-missing') {
  const repositoryRoot = realpathSync.native(process.cwd());
  const artifactsRoot = path.join(repositoryRoot, 'test-results', 'studio-t06-ui');
  await mkdir(artifactsRoot, { recursive: true });
  const runRoot = realpathSync.native(await mkdtemp(path.join(artifactsRoot, `${mode}-`)));
  const appRoot = path.join(runRoot, 'app'), profile = path.join(runRoot, 'profile');
  await mkdir(appRoot);
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  await writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ name: manifest.name, productName: manifest.productName,
    version: manifest.version, type: 'module', main: 'dist-electron/main/index.js' }, null, 2));
  await cp(path.join(repositoryRoot, 'dist'), path.join(appRoot, 'dist'), { recursive: true });
  await cp(path.join(repositoryRoot, 'dist-electron'), path.join(appRoot, 'dist-electron'), { recursive: true });
  const mainSource = path.join(repositoryRoot, 'electron/main/index.ts');
  const runtimeSource = path.join(repositoryRoot, 'electron/main/subtitle-studio/transcription/runtime.ts');
  const substitute = path.join(repositoryRoot, 'test/subtitle-studio/helpers/transcription-ui-runtime.ts');
  const preloadSource = path.join(repositoryRoot, 'dist-electron/preload/index.mjs');
  const output = path.join(appRoot, 'dist-electron/main/index.js');
  let substitutions = 0;
  if (mode === 'controlled') {
    const result = await esbuild.build({ absWorkingDir: repositoryRoot, entryPoints: [mainSource], outfile: output,
      bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', metafile: true,
      logLevel: 'silent', plugins: [{ name: 'exact-transcription-runtime-fixture', setup(build) {
        build.onResolve({ filter: /^@\// }, args => {
          const candidate = path.join(repositoryRoot, 'src', args.path.slice(2));
          const resolved = [candidate, `${candidate}.ts`, `${candidate}.tsx`, `${candidate}.json`, path.join(candidate, 'index.ts')]
            .find(file => existsSync(file));
          if (!resolved) throw new Error(`UI fixture cannot resolve application alias ${args.path}`);
          return { path: resolved };
        });
        build.onLoad({ filter: /[\\/]subtitle-studio[\\/]transcription[\\/]runtime\.ts$/ }, async args => {
          if (path.resolve(args.path) !== runtimeSource) throw new Error(`Unexpected runtime substitution ${args.path}`);
          substitutions++;
          return { contents: await readFile(substitute, 'utf8'), resolveDir: path.dirname(substitute), loader: 'ts' };
        });
      } }],
    });
    if (substitutions !== 1) throw new Error(`Expected exactly one native runtime substitution; found ${substitutions}.`);
    await writeFile(path.join(runRoot, 'main-metafile.json'), JSON.stringify(result.metafile, null, 2));
  }
  const originalPreload = await readFile(preloadSource), copiedPreload = await readFile(path.join(appRoot, 'dist-electron/preload/index.mjs'));
  if (!originalPreload.equals(copiedPreload)) throw new Error('Production preload changed in the isolated UI build.');
  await writeFile(path.join(runRoot, 'build-evidence.json'), JSON.stringify({ mode, substitutions,
    productionMainSourceSha256: digest(await readFile(mainSource)), productionRuntimeSourceSha256: digest(await readFile(runtimeSource)),
    preloadSha256: digest(originalPreload), rendererHtmlSha256: digest(await readFile(path.join(appRoot, 'dist/index.html'))),
    executedMainSha256: digest(await readFile(output)), ...(mode === 'controlled' ? { fixtureSha256: digest(await readFile(substitute)) } : {}),
  }, null, 2));
  return { appRoot, profile, artifacts: runRoot, async cleanup() {
    // Only remove this run's generated app and profile; retain all proof artifacts.
    for (const target of [appRoot, profile]) {
      const relative = path.relative(runRoot, path.resolve(target));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('UI cleanup escaped the owned run root.');
      await rm(target, { recursive: true, force: true });
    }
  } };
}
