import { describe, expect, it } from "vitest";
import {
  applyAudioProviderPreset,
  createAudioApiFormState,
  getConfiguredAudioTasks,
  setCustomAudioRoute,
  validateAudioApiForm,
} from "./audioApiConfigModel";

describe("audio API config model", () => {
  it("creates a MiMo form with all built-in compatible routes", () => {
    const state = createAudioApiFormState();

    expect(state.providerPreset).toBe("mimo");
    expect(state.baseUrl).toBe("https://api.xiaomimimo.com/v1");
    expect(getConfiguredAudioTasks(state.routes)).toEqual([
      "transcription",
      "speechSynthesis",
      "realtimeCaptions",
    ]);
    expect(Object.keys(state.routes.speechSynthesis)).toEqual([
      "preset_voice",
      "voice_design",
      "voice_clone",
    ]);
  });

  it("resets credentials, routes, and endpoint when the provider preset changes", () => {
    const state = applyAudioProviderPreset(
      {
        ...createAudioApiFormState(),
        name: "Private audio",
        apiKey: "sk-private",
      },
      "openai",
    );

    expect(state.name).toBe("Private audio");
    expect(state.apiKey).toBe("");
    expect(state.baseUrl).toBe("https://api.openai.com/v1");
    expect(getConfiguredAudioTasks(state.routes)).toEqual([
      "transcription",
      "speechSynthesis",
      "realtimeCaptions",
      "realtimeVoice",
    ]);
  });

  it("preserves form state when the active provider preset is selected again", () => {
    const state = {
      ...createAudioApiFormState(),
      name: "Private audio",
      apiKey: "sk-private",
    };

    expect(applyAudioProviderPreset(state, "mimo")).toBe(state);
    expect(state.apiKey).toBe("sk-private");
  });

  it("requires identity, credentials, a valid HTTP endpoint, and a route", () => {
    const state = createAudioApiFormState(null, "custom_openai_compatible");
    const validation = validateAudioApiForm(state);

    expect(validation.draft).toBeNull();
    expect(validation.fieldErrors).toEqual({
      name: "name_required",
      baseUrl: "base_url_required",
      apiKey: "api_key_required",
      routes: "route_required",
    });

    const invalidUrl = validateAudioApiForm({
      ...state,
      name: "Custom",
      apiKey: "key",
      baseUrl: "file:///private/audio",
    });
    expect(invalidUrl.fieldErrors.baseUrl).toBe("base_url_invalid");
  });

  it("builds and validates explicit custom compatible routes", () => {
    let state = {
      ...createAudioApiFormState(null, "custom_openai_compatible"),
      name: "Local audio",
      apiKey: "local-key",
      baseUrl: "http://127.0.0.1:8787/v1/audio/speech?debug=1",
    };
    state = setCustomAudioRoute(state, "transcription", true, "whisper-1");
    state = setCustomAudioRoute(
      state,
      "speechSynthesis.preset_voice",
      true,
      "tts-1",
    );

    const validation = validateAudioApiForm(state);
    expect(validation.fieldErrors).toEqual({});
    expect(validation.routeErrors).toEqual({});
    expect(validation.draft?.baseUrl).toBe("http://127.0.0.1:8787/v1");
    expect(getConfiguredAudioTasks(validation.draft!.routes)).toEqual([
      "transcription",
      "speechSynthesis",
    ]);
  });

  it("reports an enabled custom route without a model", () => {
    let state = {
      ...createAudioApiFormState(null, "custom_openai_compatible"),
      name: "Custom",
      apiKey: "key",
      baseUrl: "https://audio.example.test/v1",
    };
    state = setCustomAudioRoute(state, "realtimeVoice", true);

    const validation = validateAudioApiForm(state);
    expect(validation.draft).toBeNull();
    expect(validation.routeErrors.realtimeVoice).toBe(
      "route_model_required",
    );
  });
});
