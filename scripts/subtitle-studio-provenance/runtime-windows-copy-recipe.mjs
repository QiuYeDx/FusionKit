// T07 owns this additional derivation. T01/T02/T03 source and recipes stay frozen.
const edit = (from, to, count = 1, reason = 'Independent Studio Windows staging namespace and dependency closure.') => ({ from, to, count, reason });
const source = 'scripts/local-subtitle/runtime/';
const destination = 'scripts/subtitle-studio/transcription/runtime/';
const file = (name, edits = []) => ({ sourcePath: source + name, destinationPath: destination + name, edits });

export const RUNTIME_WINDOWS_FORK_PATH = 'resources/subtitle-studio/provenance/transcription-runtime-windows-fork.json';
export const RUNTIME_WINDOWS_COPY_RECIPE = {
  schemaVersion: 1,
  sourceCommit: '3a0f50ed15c1b63451402cecf27240182235e567',
  baselinePath: 'resources/subtitle-studio/provenance/transcription-baseline.json',
  baselineSha256: 'c6367bddd06cf2e31ecf04dbbe8766f70edff888775fbd14a46114ea8c29ac66',
  files: [
    file('stage-runtime-windows-x64.mjs', [
      edit('  copyFile,\n', ''),
      edit('  rename,\n', ''),
      edit('  rm,\n', ''),
      edit('} from "./stage-runtime.mjs";', '  assertRuntimeOutputMissing,\n  copyRuntimeArtifact,\n  withRuntimePublication,\n} from "./stage-runtime-windows-helpers.mjs";'),
      edit('path.resolve(SCRIPT_DIRECTORY, "../../..")', 'path.resolve(SCRIPT_DIRECTORY, "../../../..")'),
      edit('"resources/local-subtitle/licenses"', '"resources/subtitle-studio/transcription/licenses"'),
      edit('  const finalRoot = path.join(outputParent, "local-subtitle");\n  const partialRoot = path.join(\n    outputParent,\n    `local-subtitle.partial-${process.pid}-${Date.now()}`,\n  );\n  await assertMissing(finalRoot, "The final runtime staging directory already exists.");\n  await assertMissing(partialRoot, "The temporary runtime staging directory already exists.");',
        '  await assertRuntimeOutputMissing(outputParent);', 1, 'Reject existing files/directories/links before reading inputs; reserve a private output only after validation.'),
      edit('  try {\n    await mkdir(partialRoot, { recursive: true });', '  return withRuntimePublication(outputParent, async ({ partialRoot, finalRoot, publish }) => {', 1, 'A new reviewed helper claims the publisher lock and owns bounded cleanup of a unique private staging directory.'),
      edit('await copyFile(input.inputPath, outputPath)', 'await copyRuntimeArtifact(input.inputPath, outputPath)', 1, 'Copy bytes with COPYFILE_EXCL; never hardlink or overwrite an existing leaf.'),
      edit('"local-subtitle-runtime-win32-x64-v1"', '"subtitle-studio-runtime-win32-x64-v1"'),
      edit('await rename(partialRoot, finalRoot)', 'await publish()', 1, 'Recheck no-clobber publication under the new Studio publisher lock.'),
      edit('"local-subtitle-production-freeze-v1"', '"subtitle-studio-t07-windows-runtime-v1"'),
      edit('  } catch (error) {\n    await rm(partialRoot, { recursive: true, force: true });\n    throw error;\n  }\n}', '  });\n}', 1, 'Publication helper joins cleanup and preserves the primary failure.'),
      edit('const SIGNING_SCRIPT = path.join(\n  SCRIPT_DIRECTORY,\n  "authenticode-sign-file.ps1",\n);', 'const SIGNING_SCRIPT = null; // The frozen Windows contract admits only unsigned final bytes.'),
    ]),
    file('audit-ffmpeg-windows-x64.mjs', [
      edit('cwd: expandedRoot,', 'cwd: path.dirname(process.execPath),', 1, 'Use the short installed Node directory for native probes; expanded input paths remain explicit.'),
      edit('await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\\n`, "utf8");', 'await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\\n`, { encoding: "utf8", flag: "wx" });', 1, 'New audit receipts must not overwrite historical evidence.'),
    ]),
    file('ffmpeg-source-release.mjs', [
      edit('{ recursive: true, force: true }', '{ recursive: true, force: true, maxRetries: 5, retryDelay: 100 }', 2, 'Bound Windows private GPG workspace cleanup retries without changing verification.'),
      edit('fusionkit-ffmpeg-gpgv-windows-', 'fusionkit-studio-ffmpeg-gpgv-windows-'),
      edit('fusionkit-ffmpeg-gpg-', 'fusionkit-studio-ffmpeg-gpg-'),
    ]),
    file('stage-runtime-windows-x64.test.mjs'),
    file('audit-ffmpeg-windows-x64.test.mjs'),
    file('ffmpeg-source-release.test.mjs'),
  ],
  deferred: [
    'stage-runtime-windows-helpers.mjs is a new reviewed composition helper, not a mechanically copied baseline file.',
    'Windows CPU official binaries only; model health, real transcription, CUDA execution and complete Electron packaging need separate evidence.',
    'The native overwrite addon is staged independently after this runtime publisher completes.',
    'Pinned upstream source/release/evidence bytes remain unchanged; historical provenance strings are not runtime dependencies.',
  ],
};
