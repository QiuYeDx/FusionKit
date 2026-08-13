# FK-PIT-0088: Use switches for Boolean tool settings

## Area

Frontend / tool configuration semantics.

## Triggers

Checkbox, Switch, boolean setting, toggle row, hot-zone card, multi-select,
configuration consistency.

## Symptoms

An immediately applied on/off setting appears as a checkbox inside a full-row
configuration card, while equivalent settings on another tool page use a
Switch. Tool pages drift visually and the control implies selection from a set
instead of changing a persistent state.

## Root cause

The data type is Boolean, but the interaction semantics were not classified.
Checkbox is reused for both independent settings and multi-selection, and each
consumer implements its own row styling.

## Do

- Use `ToolSwitchRow` for an immediately applied Boolean tool setting with a
  full-row interaction target.
- Use `Switch` in `ToolField.action` when the compact field layout is already
  the established surface.
- Keep Checkbox for selecting zero or more output formats, granularities,
  files, tasks, or other members of a set.
- Preserve the existing state update and disabled behavior when changing only
  the control semantics.
- Bind the full-row label to the Switch and verify `role="switch"` plus
  `aria-checked` in Electron.

## Avoid

- Do not classify every Boolean-valued expression as a checkbox.
- Do not replace genuine multi-select controls with Switch.
- Do not copy the file-name translator row classes into each consumer; reuse
  `ToolSwitchRow` so layout and accessibility stay aligned.

## Validation

- Run the shared `ToolSwitchRow` and Boolean-consumer contract tests.
- In Electron, click both the Switch itself and the surrounding row and confirm
  each interaction changes the state exactly once.
- Compare the file-name translator baseline with migrated tool pages and check
  narrow-layout overflow.
- Confirm the remaining tool-page Checkbox consumers are all multi-selection
  surfaces.

## Related files

- `src/pages/Tools/_shared/ui/ToolSwitchRow.tsx`
- `src/pages/Tools/Rename/NameTranslator/components/OptionsPanel.tsx`
- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`
- `src/pages/Tools/Subtitle/SubtitleConverter/index.tsx`
- `src/pages/Tools/Audio/SpeechSynthesizer/index.tsx`
