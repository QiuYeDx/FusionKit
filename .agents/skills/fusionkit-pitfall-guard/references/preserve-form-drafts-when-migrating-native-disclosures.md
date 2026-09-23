# FK-PIT-0165: Preserve draft state when replacing native disclosure panels

## Area

Frontend / Radix Accordion / translation materials forms.

## Triggers

Native details/summary, default triangle marker, Accordion migration, forceMount, partially edited fields, empty custom language, raw multiline input.

## Symptoms

Replacing a native details panel with a default Accordion can discard unfinished local field state on collapse. Keeping content mounted without a complete hiding strategy can leave controls styled as visible even after the panel has collapsed.

## Root cause

Native details preserves its descendants. Radix content normally unmounts children after closing. FusionKit LinesField preserves raw whitespace locally, while LanguageField keeps an empty custom-language selection locally; neither state is fully represented by the normalized parent value. Merely clipping a mounted region does not change descendant visibility or remove its controls from interaction.

## Do

- Reuse the shadcn-style Accordion primitive and KnowledgeDisclosure for translation materials secondary sections instead of leaving browser-default summary markers.
- Keep unfinished form descendants mounted; combine layout collapse with visibility, inert and aria-hidden while closed. Respect reduced motion.
- Preserve independent nested section state and existing default-open behavior.
- Inventory dialog-only surfaces and advanced settings as well as the page body. Studio uses `StudioDisclosure` for compact document/configuration sections and `KnowledgeDisclosure` for retained execution materials; both delegate the trigger and chevron to the shared Accordion.
- Preserve existing lazy result rendering separately from mounted form state. Adding Accordion headings also requires title-specific test locators (`level: 2` or `dialog-title`) instead of assuming a dialog contains only one heading.
- Migrate Tour anchors and native test locators to the actual accordion trigger and aria-expanded rather than HTMLDetailsElement.open.
- In Electron, type multiline text containing blank lines and trailing whitespace, collapse and reopen, then compare the exact raw input. Also exercise the empty custom-language state before entering a value.
- Locate required controls by their accessible role and name; a label's raw text may also contain its decorative required marker.
- Exercise `:focus-visible` with actual keyboard navigation. Calling `.focus()` after mouse hover can retain pointer modality and cannot prove a keyboard focus ring or its neighboring-divider behavior.

## Avoid

- Treating normalized saved values as proof that an in-progress draft survived unmounting.
- Using forceMount alone without hiding closed content from focus and accessibility.
- Replacing already styled disclosure rows without preserving their hover, divider or destructive-action contracts. When the user requests complete unification, migrate those rows too and validate their existing contracts.

## Validation

- Build renderer/main/preload from the current source.
- Run FUSIONKIT_KNOWLEDGE_E2E=1 with test/translation-knowledge/electron.test.ts and consumer-ux-electron.test.ts.
- Inspect collapsed and expanded states in Chinese/light/wide and English/dark/narrow windows, including keyboard focus and long labels.
- Run the real Subtitle Studio boundary checker when a shared form imports a new presentation component.

## Related files

- src/components/ui/accordion.tsx
- src/pages/TranslationKnowledge/KnowledgeDisclosure.tsx
- src/pages/TranslationKnowledge/Controls.tsx
- src/pages/TranslationKnowledge/KnowledgeTour.tsx
- test/translation-knowledge/electron.test.ts
