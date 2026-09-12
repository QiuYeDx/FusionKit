// Frozen T03 maintenance recipe. Never imported by packaged application code.
const edit = (from, to, count = 1) => ({ from, to, count, reason: 'Independent Studio resource root, manifest identity or fixture location; verification behavior and upstream pins are unchanged.' });
const runtime = 'scripts/local-subtitle/runtime/';
const destination = 'scripts/subtitle-studio/transcription/runtime/';
const rootEdits = [
  edit('"build/local-subtitle-resources/local-subtitle"', '"build/subtitle-studio-resources/transcription"'),
  edit('"local-subtitle"', '"subtitle-studio/transcription"'),
  edit('"manifests/local-subtitle-runtime.v1.json"', '"manifests/subtitle-studio-runtime.v1.json"'),
];

export const TOOLING_FORK_PATH = 'resources/subtitle-studio/provenance/transcription-tooling-fork.json';
export const TOOLING_COPY_RECIPE = {
  schemaVersion: 1,
  sourceCommit: '3a0f50ed15c1b63451402cecf27240182235e567',
  baselinePath: 'resources/subtitle-studio/provenance/transcription-baseline.json',
  baselineSha256: 'c6367bddd06cf2e31ecf04dbbe8766f70edff888775fbd14a46114ea8c29ac66',
  files: [
    { sourcePath: runtime + 'runtime-manifest.mjs', destinationPath: destination + 'runtime-manifest.mjs', edits: [] },
    { sourcePath: runtime + 'staging-contract.mjs', destinationPath: destination + 'staging-contract.mjs', edits: [
      ...rootEdits,
      edit('"../../../resources/local-subtitle/manifests/local-subtitle-staging.v1.json"', '"../../../../resources/subtitle-studio/transcription/manifests/subtitle-studio-staging.v1.json"'),
    ] },
    { sourcePath: runtime + 'runtime-manifest.test.mjs', destinationPath: destination + 'runtime-manifest.test.mjs', edits: [
      edit('"../../../resources/local-subtitle/licenses"', '"../../../../resources/subtitle-studio/transcription/licenses"'),
      edit('"real-local-subtitle"', '"real-subtitle-studio"'),
      edit('"local-subtitle"', '"subtitle-studio"'),
      edit('`local-subtitle-${', '`subtitle-studio-${'),
    ] },
    { sourcePath: runtime + 'staging-contract.test.mjs', destinationPath: destination + 'staging-contract.test.mjs', edits: [
      ...rootEdits.filter(change => change.from !== '"local-subtitle"'),
      edit('assert.equal(PACKAGED_RUNTIME_ROOT, "local-subtitle")', 'assert.equal(PACKAGED_RUNTIME_ROOT, "subtitle-studio/transcription")'),
      edit('path.join(projectRoot, "build", "local-subtitle-resources", "local-subtitle")', 'path.join(projectRoot, "build", "subtitle-studio-resources", "transcription")'),
      edit('path.join(projectRoot, "build", "local-subtitle-resources")', 'path.join(projectRoot, "build", "subtitle-studio-resources")'),
    ] },
  ],
  deferred: [
    'These verifier sources do not stage an ASR runtime, download upstream files, create installed receipts, or prove a complete application package.',
    'Native source and overwrite tooling have their own T03 provenance; T01 and the 120-file T02 fork remain immutable.',
    'Full macOS/Windows runtime staging and outer application signing remain later work. Outer signing must preserve both frozen resource roots and receive independent system verification.',
  ],
};
