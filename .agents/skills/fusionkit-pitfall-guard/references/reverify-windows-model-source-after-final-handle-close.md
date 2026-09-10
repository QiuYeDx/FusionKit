# FK-PIT-0121: Reverify Windows model sources after final handle close

## Area
Windows native model lifecycle / file identity

## Triggers
NTFS, ctime, unlink, FileHandle.close, move import, model_corrupt.

## Symptoms
Copy succeeds but move restores the original source and fails model_corrupt. Four existing modelManager tests fail on Windows.

## Root cause
After unlinking the source name while a handle remains open, NTFS can update ctime again when that handle closes. The quarantined hard link retains dev/inode/birthtime/size/mtime, but the pre-close ctime no longer matches. This was reproduced with the actual filesystem, rather than inferred from an assertion failure.

## Do
At this owned transition only, require the same regular file object and content metadata. Reverify the model against the pinned header, byte size and SHA-256 after close, freeze that verified identity, and keep the final full identity check before deletion. If verification fails, preserve/restore the original and roll back the managed copy.

## Avoid
Do not globally ignore ctime or downgrade model_corrupt assertions. Do not use a successful copy as proof that source deletion and rollback work.

## Validation
Run test/local-subtitle/modelManager.test.ts on Windows: successful move, delete failure rollback, failure after unlink, and post-close verification rejection. The final rejection must not call source removal and must preserve original bytes. Other hosts retain their original path.

## Related files
electron/main/local-subtitle/model-manager.ts; test/local-subtitle/modelManager.test.ts; docs/features/subtitle-studio/records/2026-09-10-i1-closeout.md.
