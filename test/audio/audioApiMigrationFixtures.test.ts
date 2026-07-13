import { describe, expect, it } from "vitest";
import { LEGACY_AUDIO_MIGRATION_FIXTURES } from "./fixtures/legacyAudioSettings";

describe("legacy audio settings migration fixtures", () => {
  it("freeze the v5 envelope and deterministic target scenarios", () => {
    expect(Object.keys(LEGACY_AUDIO_MIGRATION_FIXTURES)).toEqual([
      "textOnly",
      "openAiFileAudio",
      "sharedMimoConnection",
      "missingConnectionAndRealtimeFallback",
      "idempotentExistingTarget",
      "assignmentNeedsAttention",
    ]);

    for (const fixture of Object.values(LEGACY_AUDIO_MIGRATION_FIXTURES)) {
      expect([4, 5]).toContain(fixture.source.version);
      expect(fixture.source.state).toHaveProperty("profiles");
      expect(fixture.source.state).toHaveProperty("audioProfiles");
      expect(Object.keys(fixture.expected.assignment).sort()).toEqual([
        "realtimeCaptions",
        "realtimeVoice",
        "speechSynthesis",
        "transcription",
      ]);
      expect(() => JSON.stringify(fixture)).not.toThrow();
    }
  });

  it("preserves missing connections and custom MiMo routes for repair", () => {
    const missing = LEGACY_AUDIO_MIGRATION_FIXTURES
      .missingConnectionAndRealtimeFallback.expected.profiles[0];
    expect(missing).toMatchObject({
      id: "audio_missing_connection",
      apiKey: "",
      baseUrl: "",
      migration: { needsAttention: true },
    });

    const custom = LEGACY_AUDIO_MIGRATION_FIXTURES
      .sharedMimoConnection.expected.profiles[1];
    expect(custom.routes.speechSynthesis.voice_clone).toMatchObject({
      model: "mimo-custom-clone",
    });
    expect(custom.migration?.needsAttention).toBe(true);
  });

  it("keeps existing migrated and manual profiles idempotent", () => {
    const fixture = LEGACY_AUDIO_MIGRATION_FIXTURES.idempotentExistingTarget;
    expect(fixture.existingTarget).toEqual(fixture.expected);
    expect(
      fixture.expected.profiles.map((profile) => profile.id),
    ).toEqual(["audio_mimo_known", "audio_manual"]);
  });

  it("preserves assignments that need route repair", () => {
    const fixture = LEGACY_AUDIO_MIGRATION_FIXTURES.assignmentNeedsAttention;
    expect(fixture.expected.assignment.transcription).toBe(
      "audio_speech_only",
    );
    expect(fixture.expected.profiles[0].routes.transcription).toBeUndefined();
    expect(fixture.expected.profiles[0].migration?.needsAttention).toBe(true);
  });
});
