# FusionKit pitfall index

Read this index first, then open only the detail files that plausibly match the current task.

| ID | Area | Triggers / symptoms | Detail |
| --- | --- | --- | --- |
| FK-PIT-0001 | Electron visual QA | screenshot is only loading, `100%`, blank white/black screen, visual matrix, Playwright Electron, preload loading | [electron-visual-qa-wait-for-loading.md](electron-visual-qa-wait-for-loading.md) |
| FK-PIT-0002 | Frontend services | Vite/Electron left running, AGENTS says close services, process cleanup before final | [frontend-service-cleanup-before-final.md](frontend-service-cleanup-before-final.md) |

## Add new cases

Use `scripts/add_pitfall.py` from the skill root when possible. Each pitfall should live as one Markdown file directly under `references/`, and every new file must have one index row here.
