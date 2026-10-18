import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ModelProfile } from "@/type/model";
import type { OnboardingLaunchMode } from "@/model-setup/contract";

// ---------------------------------------------------------------------------
// Welcome wizard: shown once to people who have nothing set up yet, and
// again whenever they reopen it from the settings.
// ---------------------------------------------------------------------------

/** never_shown: not finished or closed yet; completed: went to the end; dismissed: closed early. */
export type OnboardingStatus = "never_shown" | "completed" | "dismissed";

/**
 * Where to pick up after a next-step button took the user away from the DeepSeek step (to the
 * network settings): the pasted key, and whether the "use another service" form was open.
 * Not saved; it lives until the wizard opens again.
 */
export interface OnboardingResume {
  readonly apiKey: string;
  readonly otherService: boolean;
}

interface OnboardingStore {
  status: OnboardingStatus;
  /** Not saved: whether the wizard is on screen. */
  open: boolean;
  /** Not saved: what to restore on the next opening. */
  resume: OnboardingResume | null;
  openWizard: () => void;
  /** Closes the wizard and remembers that it was seen, so it does not open by itself again. */
  closeWizard: (status: Exclude<OnboardingStatus, "never_shown">) => void;
  /** Steps away to fix something elsewhere: the status stays as it was and the next opening resumes. */
  leaveWizard: (resume: OnboardingResume) => void;
  /** Hands the resume point to the opening wizard, once. */
  takeResume: () => OnboardingResume | null;
}

const STORAGE_KEY = "fusionkit-onboarding";

/** A profile someone can use right away: it has a key. */
export function hasUsableModelProfile(profiles: readonly Pick<ModelProfile, "apiKey">[]): boolean {
  return profiles.some((profile) => !!profile.apiKey?.trim());
}

/**
 * Whether the wizard opens by itself at launch: nothing usable is set up, it was never finished or
 * closed, and this is not an automated UI test (a test build opens it only when a test asks for it).
 */
export function shouldOpenOnboarding(input: {
  status: OnboardingStatus;
  profiles: readonly Pick<ModelProfile, "apiKey">[];
  launch: OnboardingLaunchMode;
  testBuild: boolean;
}): boolean {
  if (input.launch === "off") return false;
  if (input.testBuild && input.launch !== "forced") return false;
  return input.status === "never_shown" && !hasUsableModelProfile(input.profiles);
}

const useOnboardingStore = create<OnboardingStore>()(
  persist(
    (set, get) => ({
      status: "never_shown",
      open: false,
      resume: null,
      openWizard: () => set({ open: true }),
      closeWizard: (status) => set({ open: false, status, resume: null }),
      leaveWizard: (resume) => set({ open: false, resume }),
      takeResume: () => {
        const { resume } = get();
        if (resume) set({ resume: null });
        return resume;
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ status: state.status }),
    }
  )
);

export default useOnboardingStore;
