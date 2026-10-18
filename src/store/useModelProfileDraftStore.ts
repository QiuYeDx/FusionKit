import { create } from "zustand";
import type { Model, ModelApiFormat, OutputTokenParameter } from "@/type/model";

// ---------------------------------------------------------------------------
// A model profile form left through a next-step button (for example "open
// network settings" after a failed connection test) keeps what was typed, so
// coming back does not mean pasting the key and the address again. Held in
// memory only; nothing here is written to disk.
// ---------------------------------------------------------------------------

export interface ModelProfileFormValues {
  name: string;
  provider: Model;
  apiKey: string;
  baseUrl: string;
  modelKey: string;
  apiFormat: ModelApiFormat;
  outputTokenParameter: OutputTokenParameter;
  inputPrice: number;
  outputPrice: number;
}

/** Which form it was: the settings page's, or the one the welcome wizard opens for "use another service". */
export type ModelProfileDraftOwner = "settings" | "wizard";

export interface ModelProfileDraft {
  readonly owner: ModelProfileDraftOwner;
  /** The profile being edited, or null for a new one. */
  readonly profileId: string | null;
  readonly values: ModelProfileFormValues;
}

interface ModelProfileDraftStore {
  draft: ModelProfileDraft | null;
  /** Set by the "continue" button of the notice: the settings page opens the kept form again. */
  reopenRequested: boolean;
  keep: (draft: ModelProfileDraft) => void;
  /** Hands the kept values to the form they came from, once. */
  take: (owner: ModelProfileDraftOwner, profileId: string | null) => ModelProfileFormValues | null;
  requestReopen: () => void;
  clearReopen: () => void;
}

const useModelProfileDraftStore = create<ModelProfileDraftStore>()((set, get) => ({
  draft: null,
  reopenRequested: false,
  keep: (draft) => set({ draft, reopenRequested: false }),
  take: (owner, profileId) => {
    const { draft } = get();
    if (!draft || draft.owner !== owner || draft.profileId !== profileId) return null;
    set({ draft: null });
    return draft.values;
  },
  requestReopen: () => set({ reopenRequested: true }),
  clearReopen: () => set({ reopenRequested: false }),
}));

export default useModelProfileDraftStore;
