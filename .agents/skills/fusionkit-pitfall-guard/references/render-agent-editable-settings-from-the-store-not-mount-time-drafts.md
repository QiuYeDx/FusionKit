# FK-PIT-0187: Render agent-editable settings from the store, not mount-time drafts

## Area

Frontend state / HomeAgent page tools

## Triggers

agent updated settings,page shows old value,stale input,useState(initial store value),settings tool,custom slice length,re-enter page fixes it

## Symptoms

- HomeAgent reports that it changed a tool page setting (for example the subtitle translator's custom slice length), the store holds the new value and the next task uses it, but the open page still shows the old value.
- Leaving the page and coming back shows the correct value.

## Root cause

The page copied a store value into component state once (`useState(String(storeValue))`) so the user could type intermediate text. Since I3/I4, the store also changes from outside the page: the floating agent's `*_update_settings` page tools write it while the page stays mounted. The mount-time copy never follows those writes.

## Do

- Render settings directly from the store selector.
- When an input needs a draft (numbers that the store normalizes, so an empty or partial value would snap to the default), hold the draft only while the user is editing: `const [draft, setDraft] = useState<string | null>(null); value={draft ?? String(stored)}`, set it in `onChange` and clear it in `onBlur`.
- When adding a field to a page settings tool in `src/agent/classic-page-contexts.ts`, check that the page renders that field from the store.

## Avoid

- `useState(initialFromStore)` for any value that another surface (agent tools, another window, imports) can change.
- Syncing with an effect that overwrites the draft on every store change; it fights the user while they type.

## Validation

- `FUSIONKIT_AGENT_DOCK_E2E=1 pnpm vitest run test/agent-handoff.electron.test.ts` (after `vite build --mode=test`) changes the translator's custom slice length through the agent and asserts the open page input shows it.
- Search the classic tool pages for `useState(` seeded from config store values.

## Related files

- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`
- `src/agent/classic-page-contexts.ts`
- `src/store/tools/subtitle/useSubtitleTranslatorConfigStore.ts`
- `test/agent-handoff.electron.test.ts`
