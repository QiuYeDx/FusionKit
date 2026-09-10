# FK-PIT-0122: Canonicalize Windows isolated build roots

## Area
Windows / isolated Vite builds and acceptance

## Triggers
ADMINI~1, os.tmpdir, realpathSync, Rollup emitted chunk path, isolated build.

## Symptoms
Vite renderer build rejects a chunk name containing ../../../../../Administrator/.../index.html, while Electron main/preload builds still finish. Tests launched against that directory then fail because the renderer build is incomplete.

## Root cause
Windows temporary paths can contain an 8.3 alias. Node fs.realpathSync retained that alias on this host, while module resolution used the long path. fs.realpathSync.native returned the long canonical path. Mixed cwd/root identities produced an invalid relative asset name.

## Do
Use fs.realpathSync.native for the child build cwd on Windows, or a verified canonical Path.resolve in Python. Check the completed build exit code and logs before dispatching dependent Electron tests. Preserve the root checkout's output by building inside an owned temporary copy.

## Avoid
Do not suppress the Rollup error, accept main/preload success as renderer success, or count Electron runs dispatched after a failed build as acceptance evidence.

## Validation
Verify the original short path and its native resolved long path; full root Vite renderer/main/preload build and preload check must succeed before Electron launches. The I1 closeout record distinguishes invalid intermediate runs from final evidence.

## Related files
scripts/subtitle-studio/prepare-removal-rehearsal.py; vite.config.ts; docs/features/subtitle-studio/records/2026-09-10-i1-closeout.md.
