# FK-PIT-0130: Check the real source tree alongside boundary fixtures

## Area

Subtitle Studio / dependency boundaries / regression validation.

## Triggers

Boundary unit tests pass, standalone check fails, Unaudited package, shared UI dependency, allowlist drift.

## Symptoms

The module suite passes while the standalone dependency checker rejects new imports in the actual repository. Synthetic forbidden-import fixtures prove that the checker detects a violation but never exercise the production dependency graph.

## Root cause

The original boundary tests ran against temporary fixtures only. Adding portal and dropdown UI introduced legitimate dependencies that were absent from the audited package list; the module test command did not catch the omission.

## Do

- Run the same checker against the real repository in a focused regression test, as well as keeping negative fixtures for direct, transitive, type, dynamic, helper and resource dependencies.
- Resolve the real repository root from the test module URL so the check does not depend on the shell working directory or platform path spelling.
- Audit the concrete new imports and their purpose before adding exact package entries. A shared component is still part of the transitive graph.
- Keep historical fixture results separate from evidence that the current repository passes. Re-run the real graph after a UI dependency changes.
- Keep migration/provenance maintenance tools that intentionally read historical sources separate from the runtime graph; never permit old business imports merely to make a source inventory tool pass.

## Avoid

- Do not infer a clean production graph from green synthetic fixtures.
- Do not use broad package prefixes, skip the failing source, or weaken forbidden old-tool roots to restore green tests.
- Do not treat this source-level check as proof of runtime behavior or successful removal/packaging.

## Validation

The new real-repository test must reproduce the omission before fixing the exact audited entries. Afterwards run both the standalone checker and the full boundary test file, preserving its forbidden-dependency cases.

## Related files

- `scripts/subtitle-studio/check-boundaries.mjs`
- `scripts/subtitle-studio/boundaries.json`
- `test/subtitle-studio/boundaries.test.ts`
- `docs/features/subtitle-studio/records/2026-09-11-boundary-closeout.md`
