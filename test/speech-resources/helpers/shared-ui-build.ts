import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as esbuild from 'esbuild';
import { UI_MODELS } from './shared-ui-data';

const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export async function buildSharedResourceUiApp() {
  const repositoryRoot = realpathSync.native(process.cwd());
  const artifactsRoot = path.join(repositoryRoot, 'test-results', 'studio-t09-ui');
  await mkdir(artifactsRoot, { recursive: true });
  const artifacts = realpathSync.native(await mkdtemp(path.join(artifactsRoot, 'run-')));
  const profile = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), 't9ui-')));
  const profileIdentity = await lstat(profile);
  const appRoot = path.join(artifacts, 'app');
  const cleanup = async () => {
    const current = await lstat(profile);
    if (current.isSymbolicLink() || current.dev !== profileIdentity.dev || current.ino !== profileIdentity.ino) throw new Error('UI profile identity changed.');
    if (path.dirname(appRoot) !== artifacts) throw new Error('UI application escaped its exclusive root.');
    await rm(appRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  try {
    await mkdir(appRoot);
    const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
    await writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, type: 'module', main: 'dist-electron/main/index.js' }));
    await cp(path.join(repositoryRoot, 'dist'), path.join(appRoot, 'dist'), { recursive: true });
    await cp(path.join(repositoryRoot, 'dist-electron'), path.join(appRoot, 'dist-electron'), { recursive: true });
    const mainSource = path.join(repositoryRoot, 'electron/main/index.ts');
    const serviceSource = path.join(repositoryRoot, 'electron/main/speech-resources/service.ts');
    const substitute = path.join(repositoryRoot, 'test/speech-resources/helpers/shared-ui-service.ts');
    const output = path.join(appRoot, 'dist-electron/main/index.js');
    let substitutions = 0;
    const result = await esbuild.build({ absWorkingDir: repositoryRoot, entryPoints: [mainSource], outfile: output,
      bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', metafile: true, logLevel: 'silent',
      plugins: [{ name: 'exact-shared-resource-fixture', setup(build) {
        build.onResolve({ filter: /^\.\.\/\.\.\/\.\.\/electron\/main\/speech-resources\/service$/ }, args => {
          if (args.importer !== serviceSource) throw new Error('Original service import must originate in the exact substitution.');
          return { path: serviceSource, namespace: 'speech-t09-original' };
        });
        build.onLoad({ filter: /.*/, namespace: 'speech-t09-original' }, async () => ({ contents: await readFile(serviceSource, 'utf8'), resolveDir: path.dirname(serviceSource), loader: 'ts' }));
        build.onResolve({ filter: /^@\// }, args => {
          const candidate = path.join(repositoryRoot, 'src', args.path.slice(2));
          const resolved = [candidate, `${candidate}.ts`, `${candidate}.tsx`, `${candidate}.json`, path.join(candidate, 'index.ts')].find(file => existsSync(file));
          if (!resolved) throw new Error(`Unknown application alias ${args.path}`);
          return { path: resolved };
        });
        build.onLoad({ filter: /[\\/]speech-resources[\\/]service\.ts$/, namespace: 'file' }, async args => {
          if (path.resolve(args.path) !== serviceSource) throw new Error('Unexpected service substitution.');
          substitutions++;
          return { contents: await readFile(substitute, 'utf8'), resolveDir: path.dirname(substitute), loader: 'ts' };
        });
      } }],
    });
    if (substitutions !== 1) throw new Error(`Expected one substitution, found ${substitutions}.`);
    const sourcePreload = await readFile(path.join(repositoryRoot, 'dist-electron/preload/index.mjs'));
    if (!sourcePreload.equals(await readFile(path.join(appRoot, 'dist-electron/preload/index.mjs')))) throw new Error('Preload bytes changed.');
    const entry = UI_MODELS.find(value => value.model.id === 'large-v3-q5_0')!;
    const sourceModel = path.join(profile, 'local-subtitle/models', entry.model.id, entry.model.fileName);
    await mkdir(path.dirname(sourceModel), { recursive: true }); await writeFile(sourceModel, entry.bytes);
    const sourceIdentity = await lstat(sourceModel);
    // Real invalid-source migration evidence: preserve an unknown file, never infer ownership.
    const blockedSource = path.join(profile, 'subtitle-studio/transcription/models/large-v3');
    await mkdir(blockedSource, { recursive: true });
    await writeFile(path.join(blockedSource, 'unknown-user-note.txt'), 'UI fixture: migration must preserve this unknown file.');
    await writeFile(path.join(artifacts, 'build-evidence.json'), JSON.stringify({ syntheticUiOnly: true, substitutions,
      mainSourceSha256: digest(await readFile(mainSource)), originalServiceSha256: digest(await readFile(serviceSource)),
      substituteSha256: digest(await readFile(substitute)), preloadSha256: digest(sourcePreload), executedMainSha256: digest(await readFile(output)),
      fixtureDataSha256: digest(await readFile(path.join(repositoryRoot, 'test/speech-resources/helpers/shared-ui-data.ts'))),
      fixtureTestSha256: digest(await readFile(path.join(repositoryRoot, 'test/speech-resources/shared-ui.test.ts'))),
      rendererHtmlSha256: digest(await readFile(path.join(appRoot, 'dist/index.html'))),
      sourceModel: { path: sourceModel, sha256: entry.model.sha256, byteSize: entry.model.byteSize, dev: sourceIdentity.dev, ino: sourceIdentity.ino },
    }, null, 2));
    await writeFile(path.join(artifacts, 'main-metafile.json'), JSON.stringify(result.metafile, null, 2));
    return { appRoot, profile, artifacts, sourceModel, sourceIdentity, model: entry.model, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
