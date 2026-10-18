import { beforeEach, describe, expect, it } from "vitest";
import { Model } from "@/type/model";
import useModelProfileDraftStore, { type ModelProfileFormValues } from "./useModelProfileDraftStore";

const values: ModelProfileFormValues = {
  name: "DeepSeek",
  provider: Model.DeepSeek,
  apiKey: "sk-draft",
  baseUrl: "https://api.deepseek.com/v1",
  modelKey: "deepseek-v4-flash",
  apiFormat: "chat_completions",
  outputTokenParameter: "max_tokens",
  inputPrice: 0.28,
  outputPrice: 0.42,
};

describe("model profile form draft", () => {
  beforeEach(() => useModelProfileDraftStore.setState({ draft: null, reopenRequested: false }));

  it("gives the kept values back only to the form they came from, once", () => {
    useModelProfileDraftStore.getState().keep({ owner: "settings", profileId: null, values });
    expect(useModelProfileDraftStore.getState().take("wizard", null)).toBeNull();
    expect(useModelProfileDraftStore.getState().take("settings", "other-profile")).toBeNull();
    expect(useModelProfileDraftStore.getState().take("settings", null)).toEqual(values);
    expect(useModelProfileDraftStore.getState().take("settings", null)).toBeNull();
  });

  it("asks the settings page to open the kept form again", () => {
    useModelProfileDraftStore.getState().keep({ owner: "settings", profileId: "p1", values });
    expect(useModelProfileDraftStore.getState().reopenRequested).toBe(false);
    useModelProfileDraftStore.getState().requestReopen();
    expect(useModelProfileDraftStore.getState().reopenRequested).toBe(true);
    useModelProfileDraftStore.getState().clearReopen();
    expect(useModelProfileDraftStore.getState()).toMatchObject({ reopenRequested: false, draft: { profileId: "p1" } });
  });
});
