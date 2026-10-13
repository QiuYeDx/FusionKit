export const SETTING_TAB_KEYS = [
  "general",
  "proxy",
  "model",
  "agent",
  "external",
] as const;

export type SettingTabKey = (typeof SETTING_TAB_KEYS)[number];

const SETTING_TAB_SET = new Set<string>(SETTING_TAB_KEYS);

export function resolveSettingTab(value: string | null): SettingTabKey {
  return value && SETTING_TAB_SET.has(value)
    ? value as SettingTabKey
    : "general";
}

export function createSettingSearchParams(
  current: URLSearchParams,
  tab: SettingTabKey,
): URLSearchParams {
  const next = new URLSearchParams(current);
  next.set("tab", tab);
  return next;
}
