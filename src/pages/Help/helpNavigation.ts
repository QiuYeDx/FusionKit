/**
 * The help page's sections. The ids are stable: error notices, the update dialog and the docs link
 * to them (`/help?section=<id>`), and each section's element carries `help-<id>` as its anchor.
 */
export const HELP_SECTION_IDS = [
  "quick-start",
  "cannot-open",
  "models-and-cost",
  "download-failed",
  "transcription-failed",
  "proxy",
  "external-agent",
  "system-requirements",
] as const;

export type HelpSectionId = (typeof HELP_SECTION_IDS)[number];

export const HELP_ROUTE = "/help";

const HELP_SECTION_SET = new Set<string>(HELP_SECTION_IDS);

export function resolveHelpSection(value: string | null | undefined): HelpSectionId | undefined {
  return value && HELP_SECTION_SET.has(value) ? value as HelpSectionId : undefined;
}

/** The help page, opened at one section, for "view help" buttons elsewhere in the app. */
export function helpPath(section?: HelpSectionId): string {
  return section ? `${HELP_ROUTE}?section=${section}` : HELP_ROUTE;
}

/** The element id of a section (the router uses the URL hash, so sections are found by id). */
export function helpAnchorId(section: HelpSectionId): string {
  return `help-${section}`;
}
