# FusionKit pitfall index

Read this index first, then open only the detail files that plausibly match the current task.

| ID | Area | Triggers / symptoms | Detail |
| --- | --- | --- | --- |
| FK-PIT-0001 | Electron visual QA | screenshot is only loading, `100%`, blank white/black screen, visual matrix, Playwright Electron, preload loading | [electron-visual-qa-wait-for-loading.md](electron-visual-qa-wait-for-loading.md) |
| FK-PIT-0002 | Frontend services | Vite/Electron left running, AGENTS says close services, process cleanup before final | [frontend-service-cleanup-before-final.md](frontend-service-cleanup-before-final.md) |
| FK-PIT-0003 | Frontend | dialog, Dialog, DialogContent, 对话框, 弹窗, scrollable-dialog, qiuye-ui, 直接使用 shadcn/ui Dialog 导致滚动体验不一致 | [use-scrollable-dialog-not-raw-dialog.md](use-scrollable-dialog-not-raw-dialog.md) |
| FK-PIT-0004 | Text translation / Markdown | Markdown translation partial completion, `placeholder_mismatch`, unknown `FKP` placeholder, model drift in protected placeholders | [markdown-placeholder-drift-repair.md](markdown-placeholder-drift-repair.md) |
| FK-PIT-0005 | Text translation / Windows | Markdown output tests fail only on Windows, CRLF fixture, mixed line endings, bilingual insertion mismatch | [markdown-output-preserve-source-line-endings.md](markdown-output-preserve-source-line-endings.md) |
| FK-PIT-0006 | Frontend state / persistence | Zustand, persist, cross-key migration, hydration, legacy store, dangling references; bootstrap must complete and verify the new key before either persisted store hydrates or filters legacy state | [run-cross-key-zustand-migrations-before-hydration.md](run-cross-key-zustand-migrations-before-hydration.md) |
| FK-PIT-0007 | Electron / preload security | contextBridge, generic invoke, internal IPC, preload-only channel, file token, capability bypass; public bridges must use an exact public allowlist and keep internal invocation in private closures | [keep-preload-internal-ipc-out-of-public-invoke.md](keep-preload-internal-ipc-out-of-public-invoke.md) |
| FK-PIT-0008 | Frontend routing / state | same pathname, query tab, search params, settings navigation, AnimatePresence key; Changing only the query string does not remount App route content keyed by pathname, so tab state must derive from current search params instead of mount-only initialization. | [drive-same-path-setting-tabs-from-search-params.md](drive-same-path-setting-tabs-from-search-params.md) |

## Add new cases

Use `scripts/add_pitfall.py` from the skill root when possible. Each pitfall should live as one Markdown file directly under `references/`, and every new file must have one index row here.
