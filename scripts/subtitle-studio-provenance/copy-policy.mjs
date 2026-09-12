export const FORK_PATH = 'resources/subtitle-studio/provenance/transcription-fork.json';

export const COPY_POLICY = {
  version: 1,
  assemblySource: 'electron/main/index.ts',
  productionPrefix: 'electron/main/local-subtitle/',
  roots: [
    'src/type/localSubtitle.ts', 'src/type/localSubtitleIpc.ts',
    'src/store/tools/subtitle/localSubtitleTranscriberConfig.ts',
    'src/type/localSubtitle.test.ts', 'src/type/localSubtitleIpc.test.ts',
    'src/store/tools/subtitle/localSubtitleTranscriberConfig.test.ts',
    ...['productionExecutor', 'subtitlePostProcessor', 'serverContract', 'pauseWindowPlan', 'quietAudio',
      'cueDisplaySeparators', 'cueMultiOverlapResolver', 'cuePrefixOverlapResolver', 'cuePrefixSeparator',
      'cueVariantOverlapEvidence', 'cueContainedOverlapEvidence', 'cueBoundaryPlanner', 'cueSummary',
      'cueLocalAnchorHead', 'cueContainedOverlapResolver', 'cueVariantOverlapResolver', 'cueShortOnsetEvidence',
      'cueOverlapResolver', 'cueSeparatorRestorer', 'overlapGroupReview', 'overlapGroupSplice',
    ].map(name => `test/local-subtitle/${name}.test.ts`),
  ],
  includePrefixes: ['resources/local-subtitle/licenses/'],
  namespace: {
    ipc: 'subtitle-studio:transcription:',
    developmentRuntimeRoot: 'build/subtitle-studio-resources/transcription',
    packagedRuntimeRoot: 'subtitle-studio/transcription',
    futureManagedResourceRoot: 'userData/subtitle-studio/transcription',
  },
  textEdits: [
    { sourcePath: 'src/type/localSubtitleIpc.test.ts', from: 'for (const file of ["localSubtitle.ts", "localSubtitleIpc.ts"])', to: 'for (const file of ["domain.ts", "ipc-contract.ts"])', count: 1, reason: 'Normal regression must read its own copied domain and IPC source.' },
    { sourcePath: 'src/type/localSubtitleIpc.test.ts', from: 'path.join(process.cwd(), "src", "type", file)', to: 'path.join(process.cwd(), "src", "subtitle-studio", "transcription", file)', count: 1, reason: 'Retarget the source-reading ownership assertion to the new namespace.' },
  ],
  deferred: [
    'Native C++ and build/signing tooling are frozen in T01 but are not copied or executed in T02. Rebuild and sign the independent addon before creating its runtime manifest or exposing native operations.',
    'No runtime-ready manifest, installed binary, model, VAD file, CUDA archive or receipt is created. Manifest hashes remain upstream expected identities, not evidence of a new installed resource.',
    'Application/main/preload/UI composition remains unregistered. T03 must provide independent managed roots, resource instances and packaging contributions.',
    'Legacy artifact/export/move semantics remain in the unregistered replay closure. The document sink and copy-only user model import require explicit later adaptation.',
    'License/source-offer files retain historical paths and bytes. They describe old upstream build provenance and do not claim that the future Studio build recipes ran.',
  ],
};
