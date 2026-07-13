# FK-PIT-0008: Drive same-path setting tabs from search params

## Area

Frontend routing / state

## Triggers

same pathname, query tab, search params, settings navigation, AnimatePresence key

## Symptoms

- Navigating from a tool to `/setting?tab=audio` can leave the already-mounted
  settings page on its previous tab.
- The hash/query is correct, but the visible tab and content do not match it.
- Initializing local tab state from the query works on a cold load and fails when
  only `location.search` changes.

## Root cause

`src/App.tsx` keys its route transition wrapper by `location.pathname`. React
Router therefore keeps the same settings component mounted when only the search
params change. Mount-only initialization does not run again, and local tab state
can drift from the URL.

## Do

- Derive the active settings tab from the current `useSearchParams()` value on
  every render.
- Update tabs through `setSearchParams(..., { replace: true })` and preserve only
  validated query state.
- Key the settings content transition by the resolved tab so tab content animates
  without remounting the whole route.
- Treat `returnTo` as navigation input: use an exact internal-route allowlist and
  discard unknown values.

## Avoid

- Do not use `useState(resolveTab(searchParams.get("tab")))` as the lasting source
  of truth for same-path navigation.
- Do not rely on the App route wrapper remounting when only the query changes.
- Do not key the entire application by `location.search`; unrelated query changes
  would reset page state and route transitions.
- Do not pass an unvalidated `returnTo` value to `navigate()`.

## Validation

```text
node_modules/.bin/vitest run src/pages/Setting/settingNavigation.test.ts
node_modules/.bin/vite build --mode=test
node_modules/.bin/vitest run test/e2e.spec.ts --reporter=verbose
```

Verify a warm navigation to `#/setting?tab=audio&returnTo=...` selects the audio
tab, query-only tab changes update content, unsafe return paths are removed, and
the allowed tool return path works after saving.

## Related files

- `src/App.tsx`
- `src/pages/Setting/index.tsx`
- `src/pages/Setting/settingNavigation.ts`
- `src/pages/Setting/settingNavigation.test.ts`
- `test/e2e.spec.ts`
