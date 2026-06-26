# FK-PIT-0002: Close frontend services before final response

## Area

Frontend development servers, Electron visual QA, local process hygiene.

## Triggers

- Starting Vite, Electron, Playwright Electron, browser preview servers, or any frontend dev service.
- User/project instructions mention closing frontend service processes before final.
- Long-running `exec_command` sessions remain active.

## Symptoms

- Vite or Electron remains running after the assistant replies.
- Later validations connect to stale renderer state or a stale Electron window.
- Ports such as 5173, 7777, or preview ports appear occupied unexpectedly.

## Root cause

Visual QA and local app validation often need long-lived processes. If they are not explicitly stopped, they survive past the turn and can pollute later work.

## Do

- Track every frontend process or session started in the turn.
- Before final response, stop Vite/Electron sessions with Ctrl-C or `kill` as appropriate.
- Confirm process cleanup with `ps` plus a project-specific pattern.
- Mention cleanup in implementation records when the task updates docs or execution plans.

## Avoid

- Do not leave a Vite/Electron session running “because the task is done.”
- Do not assume Playwright/Electron closed all descendants without checking when a script failed.
- Do not run visual QA against a stale Electron process from a prior attempt.

## Validation

Example process check:

```bash
ps -axo pid,ppid,command \
  | rg '/Users/qiuyedx/Documents/Github/FusionKit/(node_modules/.bin/vite|node_modules/.bin/../vite|node_modules/.pnpm/electron|node_modules/.bin/electron)|Electron \\. --no-sandbox|vite --host 127.0.0.1|127.0.0.1:7777|VSCODE_DEBUG=1' \
  | rg -v 'rg ' || true
```

Expected output before final: empty.

## Related files

- `docs/tool-detail-page-ui-standardization-execution-plan.md`
- `docs/tool-detail-page-ui-standardization_implementation_records/2026-06-26_PRE-001_UI-001_UI-002_visual-matrix-closure.md`
