# FK-PIT-0071: Retry recursive rm on Windows to survive delete-pending ghost entries

## Area

Node / Windows NTFS file cleanup

## Triggers

`fs.rm` with `recursive: true, force: true`, Windows Defender real-time scanning, antivirus file handles, integration test temp directory cleanup, any rapid create-delete cycles on NTFS

## Symptoms

`ENOTEMPTY: directory not empty, rmdir '<path>'` from `fs.rm` or `fs.rmdir` even though no visible files remain in the directory. The error is transient — retrying after a short delay succeeds.

## Root cause

When a file is deleted on NTFS while another process (typically Windows Defender or Search Indexer) holds an open handle, the file enters a "delete pending" state. It no longer appears in `readdirSync` but still occupies a directory entry that prevents `rmdir` from succeeding. Node.js `fs.rm` internally walks directories and calls `rmdir` on each empty subdirectory; without retries, a single delete-pending ghost entry fails the entire recursive removal.

## Do

- Always pass `maxRetries` and `retryDelay` when calling `fs.rm` with `recursive: true` on Windows:

```javascript
await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
```

- Accept that Windows integration tests involving rapid file creation/deletion may encounter transient NTFS-level contention.
- If deterministic single-attempt cleanup is required, add a Windows Defender exclusion for the test temp root.

## Avoid

- Calling `fs.rm(dir, { recursive: true, force: true })` without `maxRetries` on Windows test harnesses.
- Assuming that a successful `unlinkSync` means the file is immediately gone from the directory namespace.
- Treating transient `ENOTEMPTY` during test cleanup as an addon or application bug.

## Validation

Both integration test scripts (`run-addon-windows-integration.mjs` and `run-addon-windows-recovery-integration.mjs`) pass consistently with the retry parameters. Without them, they fail approximately 80% of the time on a stock Windows installation with Defender real-time protection enabled.

## Related files

- `scripts/local-subtitle/overwrite-native/run-addon-windows-integration.mjs`
- `scripts/local-subtitle/overwrite-native/run-addon-windows-recovery-integration.mjs`
- FK-PIT-0069 (close-delete-pending-windows-handles-before-name-rechecks)
