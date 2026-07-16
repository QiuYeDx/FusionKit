# FK-PIT-0027: Check official runtime capabilities before building a native bridge

## Area

Local inference / whisper.cpp / Node process integration

## Triggers

whisper.cpp,C++,CMake,MSVC,runner,sidecar,Node,official prebuilt,whisper-server

## Symptoms

A feature is blocked on installing a compiler or designing a custom native
protocol even though the pinned upstream release may already ship a persistent,
machine-readable executable that Node can supervise.

## Root cause

The limitations of a one-shot CLI are generalized to every upstream binary.
The design jumps directly from “do not parse CLI logs” to “write a C++ runner”
without inventorying the official release or testing its server/library
surfaces. This turns an unverified implementation preference into a project
prerequisite.

## Do

- Inspect the exact pinned release archive, not only the upstream README or the
  CLI help. Record whether it ships CLI, server, shared library and backend
  dependencies.
- Test product-critical capabilities separately: model residency, structured
  final output, cancellation, health/readiness, child ownership and cleanup.
- Prefer a Node-owned official server process when it covers the required
  contract: spawn without a shell, bind loopback only, use a random private
  request path and empty static directory, sanitize the environment, and treat
  stdout/stderr as diagnostics only.
- Keep FusionKit post-processing and SRT/LRC export in TypeScript even when the
  upstream server can emit subtitle formats.
- Record missing incremental progress as an explicit UX tradeoff. Revisit a
  native bridge only if a real acceptance requirement cannot be met through
  the official structured API.
- Distinguish “Node controls an official native process” from “pure JavaScript
  imports a C library.” Direct DLL access still requires FFI/N-API and carries
  native ABI, callback/thread and Electron packaging costs.

## Avoid

- Do not infer that `whisper-cli` model reload behavior also applies to
  `whisper-server`.
- Do not parse human console progress to claim a stable machine contract.
- Do not expose an unauthenticated predictable localhost endpoint; use
  loopback, an ephemeral port and an unguessable path owned by main.
- Do not make CMake/MSVC an end-user or Windows PoC prerequisite unless source
  compilation is actually selected and justified.
- Do not keep a custom C++ plan merely because prior design documents already
  mention it; update the design and execution ledger when evidence changes.

## Validation

```text
node --test scripts/local-subtitle/whisper-server/supervisor.test.mjs
node scripts/local-subtitle/whisper-server/run-poc.mjs <ignored local arguments>
```

Confirm one server PID handles multiple files with one model load, aborting a
request leaves the process healthy, results come from structured JSON, and
shutdown leaves no child process, temporary directory or partial artifact.

## Related files

- `scripts/local-subtitle/whisper-server/supervisor.mjs`
- `scripts/local-subtitle/whisper-server/run-poc.mjs`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_final_design.md`
- `docs/v0.2.11/local-subtitle-transcriber/local-subtitle-transcriber_execution_plan.md`
- `docs/v0.2.11/local-subtitle-transcriber/fix/2026-07-17_local-subtitle-transcriber_use-node-managed-official-server.md`
