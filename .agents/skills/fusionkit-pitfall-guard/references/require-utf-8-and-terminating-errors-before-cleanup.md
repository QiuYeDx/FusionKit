# FK-PIT-0117: Require UTF-8 and terminating errors before cleanup

## Area

Windows verification / cleanup

## Triggers

PowerShell 5,ConvertFrom-Json,null PID,cleanup report

## Symptoms

A legacy default-encoding JSON read can fail without stopping cleanup; require explicit encoding, a validated PID, and terminating errors.

## Root cause

Windows PowerShell 5 reads a BOM-less UTF-8 report using a legacy default encoding unless explicitly told otherwise. ConvertFrom-Json can emit a non-terminating error, leaving the application PID null while later commands still run.

## Do

Set $ErrorActionPreference = 'Stop'; read JSON with Get-Content -Raw -Encoding utf8. Validate a finite positive recorded PID before checking processes or deleting an exact owned profile. Verify the resolved workspace target and absence of reparse points, then use native LiteralPath removal. Run process scans from a script file to avoid self-matching inline command text.

## Avoid

Do not interpret exit code zero as evidence that every PowerShell statement succeeded. Do not accept a cleanup report with a null application PID as full process cleanup proof. Do not repeat deletion just to repair a report.

## Validation

2026-09-06 short-onset production QA: the first legacy-shell report parse failed; the exact owned profile was removed after a profile-command-line scan, but PID validation was incomplete. A separate read-only check using explicit UTF-8 verified actual recorded PID 25440 and profile ownership, found zero remaining processes, and confirmed the profile absent. The cleanup report now includes the actual PID and the reason for the follow-up.

## Related files

`test-results/phase12-short-onset-cleanup.ps1` (private); `test-results/phase12-short-onset-process-check.ps1` (private); phase12 T-SEG-05T record.
