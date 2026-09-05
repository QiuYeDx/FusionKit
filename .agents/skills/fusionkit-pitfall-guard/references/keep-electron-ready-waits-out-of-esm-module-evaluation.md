# FK-PIT-0109: Keep Electron ready waits out of ESM module evaluation

## Area

Electron / isolated acceptance harness lifecycle.

## Triggers

ESM main entry, top-level await, app.whenReady, hidden BrowserWindow, configuration reader, process starts but no window or request.

## Symptoms

The isolated validation process copies its temporary storage and stays alive, but never creates its hidden window or sends a model request. No useful application error appears.

## Root cause

In the tested ESM harness, awaiting `app.whenReady()` at module top kept entry-module evaluation pending. Moving asynchronous setup into an invoked async function, without awaiting that function at module top, allowed startup to complete. This was a local harness lifecycle failure, not evidence that the model API or stored credentials were broken.

## Do

- Set the isolated userData path before creating browser sessions.
- Start asynchronous setup from an invoked async entry or ready callback; let ESM module evaluation finish.
- Track owned process IDs and separate startup from actual-request progress.
- Clean sensitive temporary profile copies after the child exits, validating the exact workspace-owned target before recursive removal.

## Avoid

- Do not repeatedly retry model credentials or endpoints when no request has started.
- Do not terminate unrelated user Electron processes to recover a harness.
- Do not report successful window startup or model validation merely because the process exists.

## Validation

On 2026-09-05, the original top-level-ready harness stalled with zero requests. After moving setup into an async entry, the same configuration produced 10 successful synthetic-subtitle requests. The owned process exited and the temporary profile directory was absent afterward.

## Related files

- `docs/v0.2.11/subtitle-quality-harness/phase3-acceptance.md`
- Ignored local harness: `test-results/subtitle-quality-review/live-model-acceptance.ts`
