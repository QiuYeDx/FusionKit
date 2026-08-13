# FK-PIT-0089: Dock terminal config disclosures to the panel bottom

## Area

Frontend / shared tool configuration layout.

## Triggers

ToolConfigDisclosure, ToolConfigPanel, last child, bottom gap, extra divider,
padding, collapsed configuration.

## Symptoms

A collapsed disclosure at the end of a configuration panel shows a horizontal
line followed by an empty strip before the rounded panel bottom. Intermediate
disclosures look correct, and expanded content may still appear functional.

## Root cause

`ToolConfigPanel` gives its body bottom padding, while `ToolConfigDisclosure`
uses negative horizontal margins and owns both top and bottom borders. When the
disclosure is the final child, the bottom border and remaining panel padding
read as an extra divider plus an empty section.

## Do

- Scope the terminal layout adjustment to the last disclosure consumer.
- Offset the panel body's bottom padding at the disclosure wrapper.
- Remove only the disclosure's bottom border so the panel outer border remains
  the final visible edge.
- Preserve the disclosure content's own bottom padding for the expanded state.
- Validate collapsed and expanded states in Electron and measure the final
  content inset.

## Avoid

- Do not change the shared disclosure default because disclosures in the middle
  of a panel still need both dividers.
- Do not remove the panel outer border or all expanded content padding.
- Do not hide the empty strip with an extra empty element or fixed height.

## Validation

- In the collapsed state, the disclosure bottom border is `0px` and its bottom
  edge meets the panel outer border.
- In the expanded state, the final content row retains its intended bottom
  padding.
- Check narrow Electron screenshots for horizontal overflow and fixed-nav
  overlap.

## Related files

- `src/pages/Tools/_shared/ui/ToolConfigPanel.tsx`
- `src/pages/Tools/_shared/ui/ToolConfigDisclosure.tsx`
- `src/pages/Tools/Subtitle/SubtitleTranslator/index.tsx`
- `src/pages/Tools/_shared/ui/toolConfigDisclosureConsumers.test.ts`
