# FK-PIT-0143: Budget complete Windows resource staging paths

## Area

Windows / real CUDA resource installation and isolated acceptance roots.

## Triggers

CUDA installation fails at preflight, `accelerator_unavailable`, `ENAMETOOLONG`, `mkdtemp`, long test-results roots, UUID staging names, forked namespaces.

## Symptoms

A valid CUDA ZIP fails before any bytes are copied even though model and VAD installation work. The public resource job exposes a sanitized preflight failure. In T08, the managed root was 140 characters; the production receipt prefix reached 247 and the generated directory reached 253. Actual Node20 mkdtemp returned ENAMETOOLONG. A 206-character control directory succeeded.

## Root cause

The installation path includes the full resource ID, generated UUID, mkdtemp suffix, archive or artifact path, and sometimes a second namespace in the manifest path. Checking only the visible output root or source file misses the final Windows path limit. A copied feature namespace can add enough characters to make only one side fail.

## Do

- Calculate complete production receipt, archive, native artifact and metadata paths before a real install; include the full default UUID and random suffix.
- Keep directory/cwd/native artifact paths conservatively within 245 characters. Check text metadata separately: its parent must fit the directory budget and the complete file path must remain below 260 on this verified host.
- Use a task-owned short mkdtemp resource root when nested report directories cannot fit. Keep reports, documents and source caches in their normal project locations.
- Preserve real production IDs, namespace, installer checks and probes. Record exact paths/lengths privately and retain a long/short filesystem counterexample.
- Track only the temporary root actually created by this run. Uninstall resources through production APIs, join processes, then remove verified empty owned directories.

## Avoid

- Do not shorten production UUIDs, disable integrity checks or use links to make a validation path work.
- Do not scan/delete the whole TEMP directory or adopt an existing userData root.
- Do not label every file as within the native-path budget when a longer text manifest uses a separate checked limit.
- Do not infer insufficient disk space from a generic preflight error without checking the actual failing operation.

## Validation

The T08 path probe records the real failing 253-character directory and successful 206-character control, and confirms both temporary probe trees were cleaned. The resource fixture checks exact generated path budgets and rejects overlong layouts before model installation. Real successful CUDA installation and GPU proof remain separate acceptance evidence.

## Related files

- `test/subtitle-studio-provenance/real-default-resource-fixture.ts`
- `test/subtitle-studio-provenance/real-default-resource-fixture.test.ts`
- `docs/features/subtitle-studio/records/2026-09-12-transcription-default-devices.md`
- `avoid-long-windows-cwd-and-async-pipes-in-native-smoke.md`
