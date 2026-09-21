import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'esbuild';
import { buildTranscriptionUiApp } from '../../subtitle-studio/helpers/transcription-ui-build';

/** Compose both tools only at the integration-test boundary; Studio owns no classic fixture. */
export async function buildEmptyResultUiApp() {
  const repositoryRoot = realpathSync.native(process.cwd());
  const mainSource = path.join(repositoryRoot, 'electron/main/index.ts');
  const controlSource = path.join(repositoryRoot, 'test/integration/helpers/empty-result-classic-control.ts');
  let injections = 0;
  const classicQueuePlugin: Plugin = { name: 'classic-empty-result-queue-fixture', setup(build) {
    build.onLoad({ filter: /[\\/]electron[\\/]main[\\/]index\.ts$/ }, async args => {
      if (path.resolve(args.path) !== mainSource) throw new Error('Unexpected main fixture injection.');
      const source = await readFile(mainSource, 'utf8');
      const marker = '  const localSubtitleOverwriteRecoveryAdmissions =';
      if (source.split(marker).length !== 2) throw new Error('Classic queue fixture anchor changed.');
      injections++;
      return { contents: `import { installClassicEmptyQueueControl } from ${JSON.stringify(controlSource.replaceAll('\\', '/'))};\n` +
        source.replace(marker, '  installClassicEmptyQueueControl(localSubtitleSessionRegistry, localSubtitleJobManager);\n' + marker),
        resolveDir: path.dirname(mainSource), loader: 'ts' };
    });
  } };
  const fixture = await buildTranscriptionUiApp('controlled', { mainPlugins: [classicQueuePlugin] });
  try {
    if (injections !== 1) throw new Error(`Expected exactly one classic queue injection; found ${injections}.`);
    const evidencePath = path.join(fixture.artifacts, 'build-evidence.json');
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    await writeFile(evidencePath, JSON.stringify({ ...evidence, classicEmptyQueue: true, classicQueueInjections: injections,
      classicFixtureSha256: createHash('sha256').update(await readFile(controlSource)).digest('hex'),
    }, null, 2));
    return fixture;
  } catch (error) {
    await fixture.cleanup();
    throw error;
  }
}
