# FK-PIT-0198: A closed panel must not count as an open dialog

## Area

Renderer layers (dialogs, menus, popovers), tool page file drops, page-level Escape and shortcuts.

## Triggers

- A panel stays mounted while closed (to measure its height, or to animate in place) and keeps `role="dialog"`,
  hiding itself only with `aria-hidden`, `inert`, `opacity: 0` or a transform.
- Code asks "is a dialog or layer open?" with `document.querySelector('[role="dialog"]')` or by checking only
  `getClientRects()` / `visibility`.

## Symptoms

- Every tool page refuses file drags: the pointer shows the "not allowed" sign over the whole page, the drop
  overlay never appears, and only the file picker button still adds files. Seen in 0.5.1 to 0.6.0 whenever an
  external agent was connected or had unseen activity, because the title bar capsule then mounts its panel.
- Escape no longer leaves tool pages, Long Text page shortcuts stop working, and the knowledge tour never opens.
- Tests did not notice: test profiles have no external connection, and the drop suite only runs with
  `FUSIONKIT_TOOL_UI_E2E=1`.

## Root cause

`ExternalAgentIndicator` kept its closed panel as `role="dialog"` with `aria-hidden`. Opacity 0 still has client
rects, so `ToolFileDropScope.hasOpenDialog()` always answered yes and set `dropEffect = "none"`;
`isLocalEscape`, `hasOpenLayer` and the knowledge tour read the same phantom dialog.

## Do

- Give an always-mounted panel its role only while open, like the assistant dock:
  `role={open ? "dialog" : undefined} aria-modal={open ? false : undefined}`.
- Mark a non-modal panel `aria-modal="false"`; page drops ignore it, and page shortcuts ignore it unless focus
  is inside. Page drops also ignore Radix popovers (`role="dialog"` inside `[data-radix-popper-content-wrapper]`,
  no `aria-modal`): a popover stays open while the user switches to Explorer to drag a file.
- When a Select or menu opens inside a modal dialog, Radix `hideOthers` sets `aria-hidden` on the dialog
  itself. A check that only looks at dialogs then sees nothing open, so also count `[role="menu"]`,
  `[role="listbox"]` and popover content, as `isLocalEscape` and the knowledge tour do.
- Ask whether a layer is open with `isShownLayer` (`src/lib/layers.ts`), which skips layers under `[hidden]`,
  `[inert]` or `[aria-hidden="true"]` and layers without a box or with hidden visibility.

## Avoid

- Do not use bare `[role="dialog"]` presence or `getClientRects()` alone as "a dialog is open".
- Do not count opacity 0 as hidden: hide a closed panel with `aria-hidden`/`inert` or unmount it.

## Validation

```text
npx vitest run src/lib/layers.test.ts test/long-text/page-shell.test.ts
pnpm run pretest
npx vitest run --maxWorkers=1 --minWorkers=1 test/tool-file-drop-panels.electron.test.ts
```

The Electron test connects a real MCP client so the title bar capsule shows. It then drops files on the
subtitle converter and the media converter (only when the staged Windows runtime exists), and drags onto the
knowledge page while its search popover is open. It also checks that a modal dialog still blocks drops and
that Escape leaves the tool page. It runs in every `pnpm test`, without an env flag.

## Related files

- `src/lib/layers.ts`, `src/pages/components/ExternalAgentIndicator.tsx`, `src/pages/AgentDock/index.tsx`
- `src/pages/Tools/_shared/ui/ToolFileDropScope.tsx`, `src/pages/Tools/_shared/useToolPageEscape.ts`
- `src/pages/Tools/Text/LongTextTranslator/hooks/usePageShortcuts.ts`, `src/pages/TranslationKnowledge/KnowledgeTour.tsx`
- `test/tool-file-drop-panels.electron.test.ts`, `test/tool-file-drop.electron.test.ts`
