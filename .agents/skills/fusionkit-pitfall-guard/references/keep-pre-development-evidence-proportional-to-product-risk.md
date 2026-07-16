# FK-PIT-0026: Keep pre-development evidence proportional to product risk

## Area

Feature planning / PRE gates / product validation

## Triggers

baseline,ground truth,corpus coverage,license evidence,PRE gate,overengineering

## Symptoms

A product-development prerequisite becomes a research benchmark and blocks implementation without reducing material product risk.

## Root cause

The plan copied research-benchmark rigor into a product-development prerequisite
without first stating the exact go/no-go question. Optional comparison metrics,
third-party application reproducibility and unavailable evidence were then
treated as blockers even though the product would use a different runtime and
could be quality-tested after a working vertical slice existed.

## Do

- Define the smallest evidence set that answers the current product decision.
- Separate development smoke, product acceptance, download integrity and release
  compliance into their owning work packages.
- Defer text-quality comparison until a real runner produces output; allow
  explicit manual acceptance when independent ground truth is not part of the
  product requirement.
- Re-evaluate speculative gates when the user clarifies the actual acceptance
  goal, and update validators, plans and status together.
- Keep security, privacy and artifact-integrity checks that protect real product
  risks even when benchmark breadth is reduced.

## Avoid

- Do not require broad language/acoustic matrices merely because they would make
  a benchmark more complete.
- Do not require an application snapshot, hidden configuration or model hash to
  reproduce a third-party tool when exact compatibility is not a goal.
- Do not manufacture a need for independently corrected transcripts or corpus
  rights audit when local, non-redistributed development samples are sufficient.
- Do not report the feature as blocked by evidence that is neither available nor
  necessary for the next implementation step.

## Validation

- The committed acceptance contract names the bounded sample scope and what it
  intentionally does not prove.
- Current real sample files pass integrity and format/timeline validation.
- Structural and strict validators both pass with no stale research-only gates.
- Final Design, Execution Plan, version ledger and implementation record agree
  on the completed prerequisite and the next unblocked work package.

## Related files

- `docs/v0.2.11/local-subtitle-transcriber/poc/benchmark-manifest.json`
- `scripts/local-subtitle/benchmark/validate-manifests.mjs`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
- `docs/v0.2.11/local-subtitle-transcriber/fix/2026-07-16_local-subtitle-transcriber_reduce-pre001-to-product-readiness.md`
