import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => {
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => { items.set(key, value); },
      removeItem: (key: string) => { items.delete(key); },
      clear: () => { items.clear(); },
      key: (index: number) => Array.from(items.keys())[index] ?? null,
      get length() { return items.size; },
    },
  });
  return items;
});

import useOnboardingStore, { hasUsableModelProfile, shouldOpenOnboarding } from "./useOnboardingStore";

describe("welcome wizard state", () => {
  beforeEach(() => {
    storage.clear();
    useOnboardingStore.setState({ status: "never_shown", open: false, resume: null });
  });

  it("opens by itself only for people with nothing usable set up who have not seen it", () => {
    const base = { status: "never_shown" as const, profiles: [], launch: "auto" as const, testBuild: false };
    expect(shouldOpenOnboarding(base)).toBe(true);
    expect(shouldOpenOnboarding({ ...base, profiles: [{ apiKey: "  " }] })).toBe(true);
    expect(shouldOpenOnboarding({ ...base, profiles: [{ apiKey: "sk-1" }] })).toBe(false);
    expect(shouldOpenOnboarding({ ...base, status: "completed" })).toBe(false);
    expect(shouldOpenOnboarding({ ...base, status: "dismissed" })).toBe(false);
  });

  it("stays closed in automated UI tests unless a test forces it", () => {
    const base = { status: "never_shown" as const, profiles: [], testBuild: true };
    expect(shouldOpenOnboarding({ ...base, launch: "auto" })).toBe(false);
    expect(shouldOpenOnboarding({ ...base, launch: "off" })).toBe(false);
    expect(shouldOpenOnboarding({ ...base, launch: "forced" })).toBe(true);
    // Forcing still respects what is already set up.
    expect(shouldOpenOnboarding({ ...base, launch: "forced", profiles: [{ apiKey: "sk-1" }] })).toBe(false);
    expect(shouldOpenOnboarding({ status: "never_shown", profiles: [], testBuild: false, launch: "off" })).toBe(false);
  });

  it("remembers that the wizard was finished or closed, but not that it is open", () => {
    useOnboardingStore.getState().openWizard();
    expect(useOnboardingStore.getState().open).toBe(true);
    useOnboardingStore.getState().closeWizard("dismissed");
    expect(useOnboardingStore.getState()).toMatchObject({ open: false, status: "dismissed" });
    expect(JSON.parse(storage.get("fusionkit-onboarding")!)).toMatchObject({ state: { status: "dismissed" } });
    expect(JSON.parse(storage.get("fusionkit-onboarding")!).state).not.toHaveProperty("open");
    useOnboardingStore.getState().openWizard();
    useOnboardingStore.getState().closeWizard("completed");
    expect(JSON.parse(storage.get("fusionkit-onboarding")!)).toMatchObject({ state: { status: "completed" } });
  });

  it("steps away to fix something without counting the wizard as seen, and resumes once", () => {
    useOnboardingStore.getState().openWizard();
    useOnboardingStore.getState().leaveWizard({ apiKey: "sk-kept", otherService: true });
    expect(useOnboardingStore.getState()).toMatchObject({ open: false, status: "never_shown" });
    // The key stays in memory only.
    expect(storage.get("fusionkit-onboarding") ?? "").not.toContain("sk-kept");
    useOnboardingStore.getState().openWizard();
    expect(useOnboardingStore.getState().takeResume()).toEqual({ apiKey: "sk-kept", otherService: true });
    expect(useOnboardingStore.getState().takeResume()).toBeNull();
    // Finishing or closing drops a resume point nobody used.
    useOnboardingStore.getState().leaveWizard({ apiKey: "sk-kept", otherService: false });
    useOnboardingStore.getState().closeWizard("dismissed");
    expect(useOnboardingStore.getState().takeResume()).toBeNull();
  });

  it("counts a profile as usable once it has a key", () => {
    expect(hasUsableModelProfile([])).toBe(false);
    expect(hasUsableModelProfile([{ apiKey: "" }, { apiKey: " sk " }])).toBe(true);
  });
});
