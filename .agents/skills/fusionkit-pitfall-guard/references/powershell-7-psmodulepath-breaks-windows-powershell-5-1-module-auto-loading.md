# FK-PIT-0200: PowerShell 7 PSModulePath breaks Windows PowerShell 5.1 module auto-loading

## Area

Build / Windows

## Triggers

pnpm build from pwsh,Get-AuthenticodeSignature,CouldNotAutoloadMatchingModule,Microsoft.PowerShell.Security,PSModulePath,vc-redist verification,build fails in pwsh,works from cmd

## Symptoms

`pnpm build` (electron-builder beforePack → `scripts/packaging/vc-redist.mjs`) fails on Windows with "The VC++ redistributable failed verification / Could not read the VC++ redistributable signature" when the build is started from a PowerShell 7 (pwsh) session, while the same cached, valid Microsoft-signed file passes the same check started from cmd or a plain node process whose environment lacks PowerShell 7 paths.

## Root cause

pwsh 7 publishes its own `PSModulePath` (including `...\PowerShell\7\Modules` and the 7 user module directory) into its process environment, and every child inherits it. When `scripts/packaging/vc-redist.mjs` spawns `powershell.exe` (5.1) to run `Get-AuthenticodeSignature`, 5.1 keeps that inherited `PSModulePath` and auto-loads the **Core edition** of `Microsoft.PowerShell.Security` found under `...\PowerShell\7\Modules`; the .NET Core module fails to load in 5.1, so the command does not exist (`CouldNotAutoloadMatchingModule`) and `execFile` exits non-zero. Verified by direct experiment: feeding pwsh 7's PSModulePath to 5.1 makes `Get-Command Get-AuthenticodeSignature` unavailable; removing PSModulePath makes 5.1 rebuild the registry default and the command works.

## Do

- Drop `PSModulePath` from the child environment before spawning `powershell.exe` (see `windowsPowerShellChildEnv` in `scripts/packaging/vc-redist.mjs`, FK-PIT-0200 fix); without the variable Windows PowerShell rebuilds its default module path from the registry.
- Compare case-insensitively when filtering env names; Windows preserves the original casing (`PSModulePath` vs `psmodulepath`).
- Reproduce packaging failures by calling the failing helper directly (`node` script importing `prepareVcRedist`) so the swallowed `cause` of the wrapper error can be printed; the build log only shows the outer message.

## Avoid

- Do not assume `powershell.exe` behaves the same regardless of the parent shell: builds launched from pwsh 7 inherit a PSModulePath that breaks 5.1 system module auto-loading.
- Do not "fix" by pointing PSModulePath at specific module directories; let 5.1 rebuild its default so custom user directories cannot poison verification either.
- Do not only test packaging scripts from one shell; a script that spawns Windows PowerShell is only proven on the shells you actually build from.

## Validation

- `node --test scripts/packaging/vc-redist.test.mjs` (includes "drops PSModulePath before spawning Windows PowerShell").
- From pwsh 7: `node <repro>` calling `prepareVcRedist({ projectRoot })` must resolve with `source: "cache"`.
- `pnpm build` from a pwsh 7 session must reach `building target=nsis` and produce `release/<version>/FusionKit_<version>_x64.exe`.

## Related files

- `scripts/packaging/vc-redist.mjs` (`inspectRedistSignature`, `windowsPowerShellChildEnv`)
- `scripts/packaging/vc-redist.test.mjs`
- Other `getWindowsPowerShellPath` callers (runtime staging, smokes, process metrics) share the same exposure when run from pwsh 7; none of them currently depend on system snap-in modules like Get-AuthenticodeSignature.
