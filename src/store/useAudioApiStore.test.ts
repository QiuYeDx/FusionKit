import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AUDIO_TASK_ASSIGNMENT,
  type AudioApiRoutes,
} from "@/type/audio";

const localStorageItems = vi.hoisted(() => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => {
        storage.clear();
      },
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    },
  });
  return storage;
});

import useAudioApiStore, {
  type AudioApiProfileDraft,
} from "./useAudioApiStore";

describe("useAudioApiStore", () => {
  beforeEach(() => {
    localStorageItems.clear();
    useAudioApiStore.setState({
      profiles: [],
      assignment: { ...DEFAULT_AUDIO_TASK_ASSIGNMENT },
      migration: {
        legacyModelStore: { status: "not_needed" },
      },
    });
  });

  it("auto-assigns every compatible task to the first audio API", () => {
    const result = useAudioApiStore.getState().addProfile(
      createDraft({ routes: createAllTaskRoutes() }),
    );

    expect(result.autoAssignedTasks).toEqual([
      "transcription",
      "speechSynthesis",
      "realtimeCaptions",
      "realtimeVoice",
    ]);
    expect(useAudioApiStore.getState().assignment).toEqual({
      transcription: result.profileId,
      speechSynthesis: result.profileId,
      realtimeCaptions: result.profileId,
      realtimeVoice: result.profileId,
    });
  });

  it("does not overwrite assignments when later audio APIs are added", () => {
    const first = useAudioApiStore.getState().addProfile(
      createDraft({ name: "First API", routes: createAllTaskRoutes() }),
    );
    const second = useAudioApiStore.getState().addProfile(
      createDraft({ name: "Second API", routes: createAllTaskRoutes() }),
    );

    expect(second.autoAssignedTasks).toEqual([]);
    expect(useAudioApiStore.getState().assignment).toEqual({
      transcription: first.profileId,
      speechSynthesis: first.profileId,
      realtimeCaptions: first.profileId,
      realtimeVoice: first.profileId,
    });
  });

  it("only undoes first-profile assignments that still match the auto-assigned profile", () => {
    const first = useAudioApiStore.getState().addProfile(
      createDraft({ name: "First API", routes: createAllTaskRoutes() }),
    );
    const second = useAudioApiStore.getState().addProfile(
      createDraft({ name: "Manual API", routes: createAllTaskRoutes() }),
    );
    expect(
      useAudioApiStore
        .getState()
        .setAssignment("transcription", second.profileId),
    ).toBe(true);
    expect(
      useAudioApiStore
        .getState()
        .setAssignment("realtimeVoice", second.profileId),
    ).toBe(true);

    expect(
      useAudioApiStore
        .getState()
        .undoAutoAssignments(first.profileId, first.autoAssignedTasks),
    ).toEqual(["speechSynthesis", "realtimeCaptions"]);
    expect(useAudioApiStore.getState().assignment).toEqual({
      transcription: second.profileId,
      speechSynthesis: null,
      realtimeCaptions: null,
      realtimeVoice: second.profileId,
    });
  });

  it("canonicalizes Base URLs when profiles are added and updated", () => {
    const { profileId } = useAudioApiStore.getState().addProfile(
      createDraft({
        baseUrl: "https://audio.example.test/v1/responses?trace=1#debug",
      }),
    );

    expect(useAudioApiStore.getState().getProfileById(profileId)?.baseUrl).toBe(
      "https://audio.example.test/v1",
    );

    expect(
      useAudioApiStore.getState().updateProfile(
        profileId,
        createDraft({
          baseUrl: "https://next.example.test/v1/audio/speech?trace=2",
        }),
      ),
    ).toBe(true);
    expect(useAudioApiStore.getState().getProfileById(profileId)?.baseUrl).toBe(
      "https://next.example.test/v1",
    );
  });

  it("replaces the complete route set when a profile is updated", () => {
    const { profileId } = useAudioApiStore.getState().addProfile(
      createDraft({ routes: createAllTaskRoutes() }),
    );
    const replacementRoutes: AudioApiRoutes = {
      speechSynthesis: {},
      realtimeVoice: {
        transport: "openai_realtime",
        model: "gpt-realtime-next",
        enabled: true,
      },
    };

    expect(
      useAudioApiStore.getState().updateProfile(
        profileId,
        createDraft({ routes: replacementRoutes }),
      ),
    ).toBe(true);
    expect(useAudioApiStore.getState().getProfileById(profileId)?.routes).toEqual(
      replacementRoutes,
    );
    expect(useAudioApiStore.getState().assignment).toEqual({
      transcription: null,
      speechSynthesis: null,
      realtimeCaptions: null,
      realtimeVoice: profileId,
    });
  });

  it("reports assignments cleared when updated routes lose task capabilities", () => {
    const { profileId } = useAudioApiStore.getState().addProfile(
      createDraft({ routes: createAllTaskRoutes() }),
    );

    const result = useAudioApiStore.getState().updateProfileWithResult(
      profileId,
      createDraft({
        routes: {
          speechSynthesis: {
            preset_voice: {
              transport: "openai_audio",
              model: "gpt-4o-mini-tts-next",
              enabled: true,
            },
          },
          realtimeVoice: {
            transport: "openai_realtime",
            model: "gpt-realtime-next",
            enabled: true,
          },
        },
      }),
    );

    expect(result).toEqual({
      updated: true,
      clearedAssignmentKeys: ["transcription", "realtimeCaptions"],
    });
    expect(useAudioApiStore.getState().assignment).toEqual({
      transcription: null,
      speechSynthesis: profileId,
      realtimeCaptions: null,
      realtimeVoice: profileId,
    });
  });

  it("preserves the boolean updateProfile contract for missing profiles", () => {
    expect(
      useAudioApiStore
        .getState()
        .updateProfile("missing-profile", createDraft()),
    ).toBe(false);
    expect(
      useAudioApiStore
        .getState()
        .updateProfileWithResult("missing-profile", createDraft()),
    ).toEqual({ updated: false, clearedAssignmentKeys: [] });
  });

  it("clears migration attention after a full profile repair", () => {
    const { profileId } = useAudioApiStore.getState().addProfile(createDraft());
    useAudioApiStore.setState((state) => ({
      profiles: state.profiles.map((profile) =>
        profile.id === profileId
          ? {
              ...profile,
              migration: {
                source: "legacy_audio_profile",
                sourceId: "legacy-speech",
                needsAttention: true,
              },
            }
          : profile,
      ),
    }));

    expect(
      useAudioApiStore.getState().updateProfile(
        profileId,
        createDraft({ name: "Reviewed speech API" }),
      ),
    ).toBe(true);
    expect(useAudioApiStore.getState().getProfileById(profileId)?.migration)
      .toEqual({
        source: "legacy_audio_profile",
        sourceId: "legacy-speech",
      });
  });

  it("rejects interactive assignments to incompatible profiles", () => {
    const { profileId } = useAudioApiStore.getState().addProfile(createDraft());

    expect(
      useAudioApiStore
        .getState()
        .setAssignment("transcription", profileId),
    ).toBe(false);
    expect(useAudioApiStore.getState().assignment).toEqual({
      ...DEFAULT_AUDIO_TASK_ASSIGNMENT,
      speechSynthesis: profileId,
    });
  });

  it("refuses to delete a profile referenced by an assignment", () => {
    const { profileId } = useAudioApiStore.getState().addProfile(createDraft());

    expect(useAudioApiStore.getState().removeProfile(profileId)).toBe(false);
    expect(useAudioApiStore.getState().getProfileById(profileId)).toBeDefined();
    expect(
      useAudioApiStore.getState().getAssignmentKeysForProfile(profileId),
    ).toEqual(["speechSynthesis"]);
  });

  it("supports explicit assignment replacement and clearing", () => {
    const first = useAudioApiStore.getState().addProfile(
      createDraft({ name: "First speech API" }),
    );
    const second = useAudioApiStore.getState().addProfile(
      createDraft({ name: "Replacement speech API" }),
    );

    expect(
      useAudioApiStore
        .getState()
        .replaceProfileAssignments(first.profileId, second.profileId),
    ).toBe(true);
    expect(useAudioApiStore.getState().assignment.speechSynthesis).toBe(
      second.profileId,
    );
    expect(useAudioApiStore.getState().removeProfile(first.profileId)).toBe(true);

    expect(
      useAudioApiStore
        .getState()
        .replaceProfileAssignments(second.profileId, null),
    ).toBe(true);
    expect(useAudioApiStore.getState().assignment.speechSynthesis).toBeNull();
    expect(useAudioApiStore.getState().removeProfile(second.profileId)).toBe(true);
  });

  it("atomically rejects an incompatible assignment replacement", () => {
    const speech = useAudioApiStore.getState().addProfile(createDraft());
    const transcription = useAudioApiStore.getState().addProfile(
      createDraft({
        name: "Transcription only",
        routes: {
          transcription: {
            transport: "openai_audio",
            model: "gpt-4o-transcribe",
            enabled: true,
          },
          speechSynthesis: {},
        },
      }),
    );
    const assignmentBefore = { ...useAudioApiStore.getState().assignment };

    expect(
      useAudioApiStore.getState().replaceProfileAssignments(
        speech.profileId,
        transcription.profileId,
      ),
    ).toBe(false);
    expect(useAudioApiStore.getState().assignment).toEqual(assignmentBefore);
  });

  it("atomically replaces each affected assignment and removes the profile", () => {
    const source = useAudioApiStore.getState().addProfile(
      createDraft({ name: "Source API", routes: createAllTaskRoutes() }),
    );
    const transcription = useAudioApiStore.getState().addProfile(
      createDraft({
        name: "Transcription API",
        routes: {
          transcription: {
            transport: "openai_audio",
            model: "gpt-4o-transcribe",
            enabled: true,
          },
          speechSynthesis: {},
        },
      }),
    );
    const speech = useAudioApiStore.getState().addProfile(
      createDraft({ name: "Speech API" }),
    );
    const realtime = useAudioApiStore.getState().addProfile(
      createDraft({
        name: "Realtime API",
        routes: {
          speechSynthesis: {},
          realtimeVoice: {
            transport: "openai_realtime",
            model: "gpt-realtime",
            enabled: true,
          },
        },
      }),
    );

    expect(
      useAudioApiStore.getState().removeProfileWithAssignments(
        source.profileId,
        {
          transcription: transcription.profileId,
          speechSynthesis: speech.profileId,
          realtimeCaptions: null,
          realtimeVoice: realtime.profileId,
        },
      ),
    ).toEqual({
      removed: true,
      affectedAssignmentKeys: [
        "transcription",
        "speechSynthesis",
        "realtimeCaptions",
        "realtimeVoice",
      ],
    });
    expect(useAudioApiStore.getState().getProfileById(source.profileId)).toBe(
      undefined,
    );
    expect(useAudioApiStore.getState().assignment).toEqual({
      transcription: transcription.profileId,
      speechSynthesis: speech.profileId,
      realtimeCaptions: null,
      realtimeVoice: realtime.profileId,
    });
  });

  it("rejects missing assignment replacements without changing store state", () => {
    const source = useAudioApiStore.getState().addProfile(
      createDraft({ name: "Source API", routes: createAllTaskRoutes() }),
    );
    const replacement = useAudioApiStore.getState().addProfile(
      createDraft({ name: "Replacement API", routes: createAllTaskRoutes() }),
    );
    const profilesBefore = useAudioApiStore.getState().profiles;
    const assignmentBefore = useAudioApiStore.getState().assignment;

    expect(
      useAudioApiStore.getState().removeProfileWithAssignments(
        source.profileId,
        {
          transcription: replacement.profileId,
          speechSynthesis: replacement.profileId,
          realtimeCaptions: replacement.profileId,
        },
      ),
    ).toEqual({
      removed: false,
      reason: "assignment_replacements_required",
      affectedAssignmentKeys: [
        "transcription",
        "speechSynthesis",
        "realtimeCaptions",
        "realtimeVoice",
      ],
      invalidReplacementKeys: ["realtimeVoice"],
    });
    expect(useAudioApiStore.getState().profiles).toBe(profilesBefore);
    expect(useAudioApiStore.getState().assignment).toBe(assignmentBefore);
  });

  it("rejects self and incompatible replacements without partially deleting", () => {
    const source = useAudioApiStore.getState().addProfile(
      createDraft({ name: "Source API", routes: createAllTaskRoutes() }),
    );
    const speechOnly = useAudioApiStore.getState().addProfile(
      createDraft({ name: "Speech only" }),
    );
    const stateBefore = useAudioApiStore.getState();

    expect(
      useAudioApiStore.getState().removeProfileWithAssignments(
        source.profileId,
        {
          transcription: source.profileId,
          speechSynthesis: null,
          realtimeCaptions: null,
          realtimeVoice: null,
        },
      ),
    ).toMatchObject({
      removed: false,
      reason: "self_replacement",
      invalidReplacementKeys: ["transcription"],
    });
    expect(useAudioApiStore.getState().profiles).toBe(stateBefore.profiles);
    expect(useAudioApiStore.getState().assignment).toBe(stateBefore.assignment);

    expect(
      useAudioApiStore.getState().removeProfileWithAssignments(
        source.profileId,
        {
          transcription: speechOnly.profileId,
          speechSynthesis: speechOnly.profileId,
          realtimeCaptions: speechOnly.profileId,
          realtimeVoice: speechOnly.profileId,
        },
      ),
    ).toMatchObject({
      removed: false,
      reason: "incompatible_replacement",
      invalidReplacementKeys: [
        "transcription",
        "realtimeCaptions",
        "realtimeVoice",
      ],
    });
    expect(useAudioApiStore.getState().profiles).toBe(stateBefore.profiles);
    expect(useAudioApiStore.getState().assignment).toBe(stateBefore.assignment);
  });

  it("rejects unknown replacement profiles without partially deleting", () => {
    const source = useAudioApiStore.getState().addProfile(
      createDraft({ name: "Source API", routes: createAllTaskRoutes() }),
    );
    const stateBefore = useAudioApiStore.getState();

    expect(
      useAudioApiStore.getState().removeProfileWithAssignments(
        source.profileId,
        {
          transcription: "missing-api",
          speechSynthesis: null,
          realtimeCaptions: null,
          realtimeVoice: null,
        },
      ),
    ).toMatchObject({
      removed: false,
      reason: "replacement_profile_not_found",
      invalidReplacementKeys: ["transcription"],
    });
    expect(useAudioApiStore.getState().profiles).toBe(stateBefore.profiles);
    expect(useAudioApiStore.getState().assignment).toBe(stateBefore.assignment);
  });

  it("never mutates the persisted text-model store during audio CRUD", () => {
    const legacyModelEnvelope = JSON.stringify({
      version: 5,
      state: {
        profiles: [{ id: "text-profile" }],
        assignment: { agent: "text-profile", taskExecution: "text-profile" },
        audioProfiles: [],
        audioAssignment: { ...DEFAULT_AUDIO_TASK_ASSIGNMENT },
      },
    });
    localStorage.setItem("fusionkit-model", legacyModelEnvelope);

    const { profileId } = useAudioApiStore.getState().addProfile(createDraft());
    expect(
      useAudioApiStore.getState().updateProfile(
        profileId,
        createDraft({ name: "Updated speech API" }),
      ),
    ).toBe(true);
    expect(
      useAudioApiStore
        .getState()
        .undoAutoAssignments(profileId, ["speechSynthesis"]),
    ).toEqual(["speechSynthesis"]);
    useAudioApiStore.getState().setAssignment("speechSynthesis", profileId);
    expect(
      useAudioApiStore
        .getState()
        .removeProfileWithAssignments(profileId, { speechSynthesis: null }),
    ).toMatchObject({ removed: true });

    expect(localStorage.getItem("fusionkit-model")).toBe(legacyModelEnvelope);
  });
});

function createDraft(
  overrides: Partial<AudioApiProfileDraft> = {},
): AudioApiProfileDraft {
  return {
    name: "Speech API",
    providerPreset: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "test-audio-key",
    routes: {
      speechSynthesis: {
        preset_voice: {
          transport: "openai_audio",
          model: "gpt-4o-mini-tts",
          enabled: true,
        },
      },
    },
    ...overrides,
  };
}

function createAllTaskRoutes(): AudioApiRoutes {
  return {
    transcription: {
      transport: "openai_audio",
      model: "gpt-4o-transcribe",
      enabled: true,
    },
    speechSynthesis: {
      preset_voice: {
        transport: "openai_audio",
        model: "gpt-4o-mini-tts",
        enabled: true,
      },
    },
    realtimeCaptions: {
      transport: "openai_realtime",
      model: "gpt-realtime-whisper",
      enabled: true,
    },
    realtimeVoice: {
      transport: "openai_realtime",
      model: "gpt-realtime",
      enabled: true,
    },
  };
}
