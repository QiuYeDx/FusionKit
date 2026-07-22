import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rm,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_SUBTITLE_LIMITS } from "../../src/type/localSubtitle";
import {
  LocalSubtitleCapabilityLeaseCoordinator,
  LocalSubtitleInputAuthorizationRegistry,
  LocalSubtitleOutputDirectoryAuthorizationRegistry,
  type LocalSubtitleOwnerKey,
} from "../../electron/main/local-subtitle/authorizations";
import {
  LOCAL_SUBTITLE_MEDIA_POLICY,
  LocalSubtitleMediaNormalizer,
  isLocalSubtitleBrandedPcmWindow,
  isLocalSubtitleNormalizedPcm,
  type LocalSubtitleMediaCommandRunner,
  type LocalSubtitleMediaStructuralWindow,
} from "../../electron/main/local-subtitle/media-normalizer";
import type {
  LocalSubtitleMediaProcessRequest,
  LocalSubtitleMediaProcessResult,
} from "../../electron/main/local-subtitle/media-process";
import { createLocalSubtitlePcm16WavHeader } from "../../electron/main/local-subtitle/pcm-window";
import {
  createRuntimeManifest,
  createRuntimeFixture,
  type LocalSubtitleRuntimeFixture,
} from "./runtimeFixture";

const OWNER_A = Object.freeze({
  webContentsId: 71,
  ownerSessionId: "media-owner-a",
}) satisfies LocalSubtitleOwnerKey;
const OWNER_B = Object.freeze({
  webContentsId: 72,
  ownerSessionId: "media-owner-b",
}) satisfies LocalSubtitleOwnerKey;

let runtime: LocalSubtitleRuntimeFixture;
let managedRoot: string;
let sourceRoot: string;
let inputs: LocalSubtitleInputAuthorizationRegistry;

beforeEach(async () => {
  runtime = await createRuntimeFixture({
    platform: "darwin",
    arch: "arm64",
    mode: "development",
  });
  managedRoot = path.join(runtime.tempRoot, "managed");
  sourceRoot = path.join(runtime.tempRoot, "user-media");
  await mkdir(sourceRoot, { recursive: true });
  inputs = new LocalSubtitleInputAuthorizationRegistry({
    tokenFactory: sequence("input"),
  });
});

afterEach(async () => {
  await runtime.cleanup();
});

describe("local subtitle media runtime and probing", () => {
  it("pins each platform media version to the staging contract", () => {
    for (const [platform, arch] of [
      ["darwin", "arm64"],
      ["win32", "x64"],
    ] as const) {
      const manifest = createRuntimeManifest(platform, arch);
      const mediaVersions = new Set(
        manifest.artifacts
          .filter(
            (artifact) =>
              artifact.kind === "ffmpeg" || artifact.kind === "ffprobe",
          )
          .map((artifact) => artifact.version),
      );
      expect([...mediaVersions]).toEqual([
        LOCAL_SUBTITLE_MEDIA_POLICY.mediaRuntimeVersions[platform],
      ]);
    }
  });

  it("probes the exact bundled ffmpeg and ffprobe versions serially", async () => {
    const sourcePath = await sourceFile("runtime-probe.mov", "runtime-probe");
    const authorized = await inputs.authorize(OWNER_A, sourcePath);
    const harness = createHarness({ yieldEveryCall: true });

    await expect(
      harness.normalizer.probeDraft({
        owner: OWNER_A,
        fileToken: authorized.fileToken,
      }),
    ).resolves.toMatchObject({ durationMs: 10_000 });

    expect(harness.calls.map((call) => call.kind)).toEqual([
      "ffmpeg-version",
      "ffprobe-version",
      "media-probe",
    ]);
    expect(harness.maxActive).toBe(1);
    const expectedCwd = await realpath(path.join(managedRoot, "temp", "media"));
    for (const call of harness.calls) {
      const executable =
        call.kind === "ffmpeg-version" || call.kind === "decode"
          ? "ffmpeg"
          : "ffprobe";
      expect(call.command).toBe(runtime.artifactPaths[
        artifactId(executable)
      ]);
      expect(call.cwd).toBe(expectedCwd);
      expect(call.env.SECRET_MEDIA_TOKEN).toBeUndefined();
      expect(call.env.PATH).toBe(path.dirname(call.command));
    }
  });

  it("verifies the media runtime without consuming an input capability", async () => {
    const harness = createHarness({ yieldEveryCall: true });

    const verification = await harness.normalizer.verifyRuntime({ owner: OWNER_A });

    expect(verification.runtimeGeneration).toMatch(/^[a-f0-9]{64}$/u);
    expect(harness.calls.map((call) => call.kind)).toEqual([
      "ffmpeg-version",
      "ffprobe-version",
    ]);
    expect(harness.maxActive).toBe(1);
  });

  it("fails before ffprobe when the bundled ffmpeg version is wrong", async () => {
    const sourcePath = await sourceFile("wrong-version.mov", "wrong-version");
    const authorized = await inputs.authorize(OWNER_A, sourcePath);
    const harness = createHarness({
      versionText: { ffmpeg: "ffmpeg version 9.0.0\n" },
    });

    await expect(
      harness.normalizer.probeDraft({
        owner: OWNER_A,
        fileToken: authorized.fileToken,
      }),
    ).rejects.toMatchObject({
      code: "runtime_launch_failed",
      localSubtitleCode: "media_runtime_launch_failed",
      stage: "preflight",
    });
    expect(harness.calls.map((call) => call.kind)).toEqual([
      "ffmpeg-version",
    ]);
  });

  it(
    "rejects managed/temp/media links without touching their external targets",
    async () => {
      const sourcePath = await sourceFile("unsafe-root.mov", "unsafe-root");
      const authorized = await inputs.authorize(OWNER_A, sourcePath);

      for (const level of ["managed", "temp", "media"] as const) {
        const customManagedRoot = path.join(
          runtime.tempRoot,
          `managed-${level}-link`,
        );
        const external = path.join(runtime.tempRoot, `external-${level}`);
        await mkdir(external, { mode: 0o755 });
        if (process.platform !== "win32") await chmod(external, 0o755);
        const linkType = process.platform === "win32" ? "junction" : "dir";

        if (level === "managed") {
          await symlink(external, customManagedRoot, linkType);
        } else {
          await mkdir(customManagedRoot, { mode: 0o700 });
          if (process.platform !== "win32") await chmod(customManagedRoot, 0o700);
          if (level === "media") {
            const tempRoot = path.join(customManagedRoot, "temp");
            await mkdir(tempRoot, { mode: 0o700 });
            if (process.platform !== "win32") await chmod(tempRoot, 0o700);
            await symlink(external, path.join(tempRoot, "media"), linkType);
          } else {
            await symlink(external, path.join(customManagedRoot, "temp"), linkType);
          }
        }

        const before = await stat(external);
        const harness = createHarness({
          managedResourceRoot: customManagedRoot,
        });
        await expect(
          harness.normalizer.probeDraft({
            owner: OWNER_A,
            fileToken: authorized.fileToken,
          }),
        ).rejects.toMatchObject({ code: "invalid_configuration" });
        const after = await stat(external);
        if (process.platform !== "win32") {
          expect(after.mode & 0o777).toBe(before.mode & 0o777);
        }
        await expect(readdir(external)).resolves.toEqual([]);
        expect(harness.calls).toEqual([]);
      }
    },
  );

  it("aborts an in-flight probe and rejects late owner records on release", async () => {
    const sourcePath = await sourceFile("owner-release.mov", "owner-release");
    const authorized = await inputs.authorize(OWNER_A, sourcePath);
    const harness = createHarness({ waitForAbortKind: "media-probe" });
    const pending = harness.normalizer.probeDraft({
      owner: OWNER_A,
      fileToken: authorized.fileToken,
    });
    await waitForCondition(() =>
      harness.calls.some((call) => call.kind === "media-probe"),
    );

    await expect(
      harness.normalizer.probeDraft({
        owner: OWNER_A,
        fileToken: authorized.fileToken,
      }),
    ).rejects.toMatchObject({
      code: "limit_exceeded",
      localSubtitleCode: "limit_exceeded",
    });

    harness.normalizer.releaseOwner(OWNER_A);

    await expect(pending).rejects.toMatchObject({
      code: "aborted",
      localSubtitleCode: "owner_released",
    });
    await expect(
      harness.normalizer.probeDraft({
        owner: OWNER_A,
        fileToken: authorized.fileToken,
      }),
    ).rejects.toMatchObject({ localSubtitleCode: "owner_released" });
  });

  it("rejects a container with no audio stream", async () => {
    const sourcePath = await sourceFile("silent.mov", "silent");
    const authorized = await inputs.authorize(OWNER_A, sourcePath);
    const harness = createHarness({
      probeOutputs: [probePayload([])],
    });

    await expect(
      harness.normalizer.probeDraft({
        owner: OWNER_A,
        fileToken: authorized.fileToken,
      }),
    ).rejects.toMatchObject({
      code: "no_audio_stream",
      localSubtitleCode: "no_audio_stream",
      stage: "preparing_media",
    });
  });

  it.each([
    {
      label: "the only track",
      tracks: [probeTrack(3)],
      selectedOrdinal: 1,
    },
    {
      label: "the unique default track",
      tracks: [probeTrack(2), probeTrack(7, true), probeTrack(9)],
      selectedOrdinal: 2,
    },
    {
      label: "the first track when no default exists",
      tracks: [probeTrack(4), probeTrack(8)],
      selectedOrdinal: 1,
    },
    {
      label: "the first track when multiple defaults exist",
      tracks: [probeTrack(5, true), probeTrack(6, true)],
      selectedOrdinal: 1,
    },
  ])("auto-selects $label", async ({ tracks, selectedOrdinal }) => {
    const sourcePath = await sourceFile("tracks.mkv", "tracks");
    const authorized = await inputs.authorize(OWNER_A, sourcePath);
    const harness = createHarness({ probeOutputs: [probePayload(tracks)] });

    const summary = await harness.normalizer.probeDraft({
      owner: OWNER_A,
      fileToken: authorized.fileToken,
    });

    expect(summary.audioTracks).toHaveLength(tracks.length);
    expect(summary.autoSelectedStreamId).toBe(
      summary.audioTracks[selectedOrdinal - 1]!.streamId,
    );
    expect(summary.audioTracks.map((track) => track.ordinal)).toEqual(
      tracks.map((_track, index) => index + 1),
    );
    expect(JSON.stringify(summary)).not.toContain("streamIndex");
    expect(Object.isFrozen(summary)).toBe(true);
    expect(Object.isFrozen(summary.audioTracks)).toBe(true);
  });

  it("cleans and bounds untrusted track metadata", async () => {
    const sourcePath = await sourceFile("metadata.mkv", "metadata");
    const authorized = await inputs.authorize(OWNER_A, sourcePath);
    const longTitle =
      `  Alpha\u0000\u200bBeta\u2028${"x".repeat(
        LOCAL_SUBTITLE_LIMITS.maxMediaMetadataFieldChars + 32,
      )}\nGamma  `;
    const harness = createHarness({
      probeOutputs: [
        probePayload([
          {
            ...probeTrack(1, true),
            codec_name: "aac\u007f",
            tags: {
              language: "\tja\u200dJP\r\n",
              title: longTitle,
            },
          },
        ]),
      ],
    });

    const summary = await harness.normalizer.probeDraft({
      owner: OWNER_A,
      fileToken: authorized.fileToken,
    });
    const track = summary.audioTracks[0]!;

    expect(track.language).toBe("ja JP");
    expect(track.codec).toBe("aac");
    expect(track.title).toMatch(/^Alpha Beta x+/u);
    expect(track.title!.length).toBeLessThanOrEqual(
      LOCAL_SUBTITLE_LIMITS.maxMediaMetadataFieldChars,
    );
    expect(track.title).toBe(track.title!.trim());
    expect(track.title).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]/u);
  });

  it("bounds per-owner probe records and expires the oldest stream binding", async () => {
    const harness = createHarness();
    let first:
      | {
          readonly fileToken: string;
          readonly streamId: string;
        }
      | undefined;

    for (
      let index = 0;
      index < LOCAL_SUBTITLE_MEDIA_POLICY.maxProbeRecordsPerOwner + 1;
      index += 1
    ) {
      const sourcePath = await sourceFile(`probe-quota-${index}.mkv`, `source-${index}`);
      const authorized = await inputs.authorize(OWNER_A, sourcePath);
      const summary = await harness.normalizer.probeDraft({
        owner: OWNER_A,
        fileToken: authorized.fileToken,
      });
      if (index === 0) {
        first = {
          fileToken: authorized.fileToken,
          streamId: summary.autoSelectedStreamId,
        };
      }
    }

    await commitTaskLease(OWNER_A, first!.fileToken, "task-probe-quota");
    await expect(
      harness.normalizer.normalizeTask({
        owner: OWNER_A,
        fileToken: first!.fileToken,
        taskId: "task-probe-quota",
        taskGeneration: 1,
        audioStreamId: first!.streamId,
      }),
    ).rejects.toMatchObject({
      code: "media_changed",
      localSubtitleCode: "media_changed",
    });
    expect(harness.decodeCount).toBe(0);
  });
});

describe("local subtitle stream binding and normalization", () => {
  it("rejects an auto-selection request whose task lease belongs to another file token", async () => {
    const sourceA = await sourceFile("lease-token-a.mov", "lease-token-a");
    const sourceB = await sourceFile("lease-token-b.mov", "lease-token-b");
    const authorizedA = await inputs.authorize(OWNER_A, sourceA);
    const authorizedB = await inputs.authorize(OWNER_A, sourceB);
    await commitTaskLease(OWNER_A, authorizedA.fileToken, "task-token-a");
    const harness = createHarness();

    await expect(
      harness.normalizer.normalizeTask({
        owner: OWNER_A,
        fileToken: authorizedB.fileToken,
        taskId: "task-token-a",
        taskGeneration: 1,
      }),
    ).rejects.toMatchObject({
      code: "invalid_ipc_request",
      field: "token",
    });
    expect(harness.calls).toEqual([]);
  });

  it("rejects stale, forged, and cross-owner stream ids before decoding", async () => {
    const sourceA = await sourceFile("owner-a.mkv", "owner-a");
    const sourceB = await sourceFile("owner-b.mkv", "owner-b");
    const authorizedA = await inputs.authorize(OWNER_A, sourceA);
    const authorizedB = await inputs.authorize(OWNER_B, sourceB);
    const tracks = [probeTrack(2), probeTrack(7, true)];
    const harness = createHarness({ probeOutputs: [probePayload(tracks)] });

    const staleA = await harness.normalizer.probeDraft({
      owner: OWNER_A,
      fileToken: authorizedA.fileToken,
    });
    const currentA = await harness.normalizer.probeDraft({
      owner: OWNER_A,
      fileToken: authorizedA.fileToken,
    });
    await harness.normalizer.probeDraft({
      owner: OWNER_B,
      fileToken: authorizedB.fileToken,
    });
    await commitTaskLease(OWNER_A, authorizedA.fileToken, "task-stream-a");
    await commitTaskLease(OWNER_B, authorizedB.fileToken, "task-stream-b");

    for (const request of [
      {
        owner: OWNER_A,
        fileToken: authorizedA.fileToken,
        taskId: "task-stream-a",
        audioStreamId: staleA.autoSelectedStreamId,
      },
      {
        owner: OWNER_A,
        fileToken: authorizedA.fileToken,
        taskId: "task-stream-a",
        audioStreamId: "ls-stream-forged",
      },
      {
        owner: OWNER_B,
        fileToken: authorizedB.fileToken,
        taskId: "task-stream-b",
        audioStreamId: currentA.autoSelectedStreamId,
      },
    ] as const) {
      await expect(
        harness.normalizer.normalizeTask({
          ...request,
          taskGeneration: 1,
        }),
      ).rejects.toMatchObject({
        code: "media_changed",
        localSubtitleCode: "media_changed",
      });
    }
    expect(harness.decodeCount).toBe(0);

    const normalized = await harness.normalizer.normalizeTask({
      owner: OWNER_A,
      fileToken: authorizedA.fileToken,
      taskId: "task-stream-a",
      taskGeneration: 1,
      audioStreamId: currentA.autoSelectedStreamId,
    });
    expect(normalized.selectedStreamId).toBe(currentA.autoSelectedStreamId);
    expect(harness.decodeCalls[0]!.args).toContain("0:7");
  });

  it("copies one private source snapshot and decodes it exactly once", async () => {
    const sourceBytes = Buffer.from("private original media bytes");
    const sourcePath = await sourceFile("snapshot.mov", sourceBytes);
    const authorized = await inputs.authorize(OWNER_A, sourcePath);
    await commitTaskLease(OWNER_A, authorized.fileToken, "task-snapshot");
    const harness = createHarness();

    const normalized = await harness.normalizer.normalizeTask({
      owner: OWNER_A,
      fileToken: authorized.fileToken,
      taskId: "task-snapshot",
      taskGeneration: 3,
    });

    expect(harness.decodeCount).toBe(1);
    expect(harness.decodeInputBytes).toEqual([sourceBytes]);
    expect(harness.decodeInputPaths[0]).not.toBe(sourcePath);
    expect(path.basename(harness.decodeInputPaths[0]!)).toBe("source.snapshot");
    expect(harness.mediaProbePaths).toEqual(harness.decodeInputPaths);
    expect(
      harness.calls
        .filter((call) => call.kind === "media-probe" || call.kind === "decode")
        .every((call) => !call.args.includes(sourcePath)),
    ).toBe(true);
    await expect(lstat(harness.decodeInputPaths[0]!)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(normalized).toMatchObject({
      taskId: "task-snapshot",
      taskGeneration: 3,
      sampleRateHz: 16_000,
      channels: 1,
      bitsPerSample: 16,
      totalFrames: 160_000,
      durationMs: 10_000,
    });
    expect(isLocalSubtitleNormalizedPcm(normalized)).toBe(true);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(JSON.stringify(normalized)).not.toContain(managedRoot);
    expect(JSON.stringify(normalized)).not.toContain(sourcePath);

    const sessions = await mediaSessions();
    expect(sessions).toHaveLength(1);
    await expect(readdir(sessions[0]!)).resolves.toEqual(["normalized.wav"]);
  });

  it("rejects replacement of the authorized source after snapshot decode", async () => {
    const sourcePath = await sourceFile("replace-after-copy.mov", "before");
    const originalPath = path.join(sourceRoot, "replace-after-copy.original");
    const authorized = await inputs.authorize(OWNER_A, sourcePath);
    await commitTaskLease(OWNER_A, authorized.fileToken, "task-replaced");
    const harness = createHarness({
      afterDecodeOutput: async () => {
        await rename(sourcePath, originalPath);
        await writeFile(sourcePath, "replacement");
      },
    });

    await expect(
      harness.normalizer.normalizeTask({
        owner: OWNER_A,
        fileToken: authorized.fileToken,
        taskId: "task-replaced",
        taskGeneration: 1,
      }),
    ).rejects.toMatchObject({
      code: "media_changed",
      localSubtitleCode: "media_changed",
    });
    expect(harness.decodeCount).toBe(1);
    expect(harness.decodeInputBytes).toEqual([Buffer.from("before")]);
    await expect(mediaSessions()).resolves.toEqual([]);
  });

  it("rejects replacement of the private source snapshot during ffprobe", async () => {
    const sourcePath = await sourceFile("replace-snapshot.mov", "snapshot-before");
    const authorized = await inputs.authorize(OWNER_A, sourcePath);
    await commitTaskLease(OWNER_A, authorized.fileToken, "task-snapshot-replaced");
    const harness = createHarness({
      afterMediaProbe: async (inputPath) => {
        await writeFile(inputPath, "snapshot-after");
      },
    });

    await expect(
      harness.normalizer.normalizeTask({
        owner: OWNER_A,
        fileToken: authorized.fileToken,
        taskId: "task-snapshot-replaced",
        taskGeneration: 1,
      }),
    ).rejects.toMatchObject({
      code: "media_changed",
      localSubtitleCode: "media_changed",
    });
    expect(harness.decodeCount).toBe(0);
    await expect(mediaSessions()).resolves.toEqual([]);
  });

  it("bounds decode bytes and duration before rejecting a short-reported source", async () => {
    const sourcePath = await sourceFile("short-duration.mov", "short-duration");
    const authorized = await inputs.authorize(OWNER_A, sourcePath);
    await commitTaskLease(OWNER_A, authorized.fileToken, "task-short-duration");
    const trustedDurationLimitMs =
      1_000 + LOCAL_SUBTITLE_MEDIA_POLICY.decodeDurationToleranceMs;
    const processDurationLimitMs =
      trustedDurationLimitMs + LOCAL_SUBTITLE_MEDIA_POLICY.decodeLimitSentinelMs;
    const outputLimitBytes =
      processDurationLimitMs * 16 * 2 +
      LOCAL_SUBTITLE_MEDIA_POLICY.maxNormalizedWavHeaderBytes;
    const harness = createHarness({
      probeOutputs: [probePayload([probeTrack(0, true)], "1.000")],
      decodedFrames: trustedDurationLimitMs * 16,
    });

    await expect(
      harness.normalizer.normalizeTask({
        owner: OWNER_A,
        fileToken: authorized.fileToken,
        taskId: "task-short-duration",
        taskGeneration: 1,
      }),
    ).rejects.toMatchObject({
      code: "limit_exceeded",
      localSubtitleCode: "limit_exceeded",
    });
    const args = harness.decodeCalls[0]!.args;
    expect(args[args.indexOf("-t") + 1]).toBe("4.000");
    expect(args[args.indexOf("-fs") + 1]).toBe(String(outputLimitBytes));
    expect(args.indexOf("-t")).toBeLessThan(args.indexOf("-rf64"));
    expect(args.indexOf("-fs")).toBeLessThan(args.indexOf("-rf64"));
    await expect(mediaSessions()).resolves.toEqual([]);
  });

  it("rejects a valid short RIFF whose non-audio chunks reach the byte cap", async () => {
    const sourcePath = await sourceFile("byte-limit.mov", "byte-limit");
    const authorized = await inputs.authorize(OWNER_A, sourcePath);
    await commitTaskLease(OWNER_A, authorized.fileToken, "task-byte-limit");
    const trustedDurationLimitMs =
      1_000 + LOCAL_SUBTITLE_MEDIA_POLICY.decodeDurationToleranceMs;
    const processDurationLimitMs =
      trustedDurationLimitMs + LOCAL_SUBTITLE_MEDIA_POLICY.decodeLimitSentinelMs;
    const outputLimitBytes =
      processDurationLimitMs * 16 * 2 +
      LOCAL_SUBTITLE_MEDIA_POLICY.maxNormalizedWavHeaderBytes;
    const harness = createHarness({
      probeOutputs: [probePayload([probeTrack(0, true)], "1.000")],
      decodedFrames: 16_000,
      afterDecodeOutput: async ({ outputPath }) => {
        await padRiffWithJunk(outputPath, outputLimitBytes);
      },
    });

    await expect(
      harness.normalizer.normalizeTask({
        owner: OWNER_A,
        fileToken: authorized.fileToken,
        taskId: "task-byte-limit",
        taskGeneration: 1,
      }),
    ).rejects.toMatchObject({
      code: "limit_exceeded",
      localSubtitleCode: "limit_exceeded",
    });
    await expect(mediaSessions()).resolves.toEqual([]);
  });

  it("keeps a truncation sentinel beyond the exact shared duration limit", async () => {
    const sourcePath = await sourceFile("maximum-duration.mov", "maximum-duration");
    const authorized = await inputs.authorize(OWNER_A, sourcePath);
    await commitTaskLease(OWNER_A, authorized.fileToken, "task-maximum-duration");
    const processDurationLimitMs =
      LOCAL_SUBTITLE_LIMITS.maxDurationMs +
      LOCAL_SUBTITLE_MEDIA_POLICY.decodeLimitSentinelMs;
    const outputLimitBytes =
      Math.ceil((processDurationLimitMs * 16_000) / 1_000) * 2 +
      LOCAL_SUBTITLE_MEDIA_POLICY.maxNormalizedWavHeaderBytes;
    const harness = createHarness({
      probeOutputs: [
        probePayload(
          [probeTrack(0, true)],
          String(LOCAL_SUBTITLE_LIMITS.maxDurationMs / 1_000),
        ),
      ],
      decodeResult: closedResult(Buffer.alloc(0), { exitCode: 1 }),
    });

    await expect(
      harness.normalizer.normalizeTask({
        owner: OWNER_A,
        fileToken: authorized.fileToken,
        taskId: "task-maximum-duration",
        taskGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: "decode_failed" });
    const args = harness.decodeCalls[0]!.args;
    expect(args[args.indexOf("-t") + 1]).toBe("360000.999");
    expect(args[args.indexOf("-fs") + 1]).toBe(String(outputLimitBytes));
    await expect(mediaSessions()).resolves.toEqual([]);
  });

  it("preserves limit_exceeded when decoded RF64 frames exceed the shared duration", async () => {
    const sourcePath = await sourceFile("duration-overflow.mov", "duration-overflow");
    const authorized = await inputs.authorize(OWNER_A, sourcePath);
    await commitTaskLease(OWNER_A, authorized.fileToken, "task-duration-overflow");
    const totalFrames = (LOCAL_SUBTITLE_LIMITS.maxDurationMs + 1) * 16;
    const harness = createHarness({
      probeOutputs: [
        probePayload(
          [probeTrack(0, true)],
          String(LOCAL_SUBTITLE_LIMITS.maxDurationMs / 1_000),
        ),
      ],
      afterDecodeOutput: async ({ outputPath }) => {
        await overwriteWithSparseRf64(outputPath, totalFrames);
      },
    });

    await expect(
      harness.normalizer.normalizeTask({
        owner: OWNER_A,
        fileToken: authorized.fileToken,
        taskId: "task-duration-overflow",
        taskGeneration: 1,
      }),
    ).rejects.toMatchObject({
      code: "limit_exceeded",
      localSubtitleCode: "limit_exceeded",
    });
    await expect(mediaSessions()).resolves.toEqual([]);
  });

  it("streams monotonic non-duplicated decode progress", async () => {
    const sourcePath = await sourceFile("progress.mov", "progress");
    const authorized = await inputs.authorize(OWNER_A, sourcePath);
    await commitTaskLease(OWNER_A, authorized.fileToken, "task-progress");
    const harness = createHarness({
      progressChunks: [
        "out_time_us=2000000\nout_time_us=2000000\n",
        "out_time_us=5000000\nprogress=end\n",
      ],
    });
    const progress: number[] = [];

    await harness.normalizer.normalizeTask({
      owner: OWNER_A,
      fileToken: authorized.fileToken,
      taskId: "task-progress",
      taskGeneration: 1,
      onProgress: (value) => progress.push(value),
    });

    expect(progress).toEqual([10, 27, 54, 100]);
    expect(progress).toEqual([...new Set(progress)]);
    expect(progress.every((value, index) => index === 0 || value > progress[index - 1]!))
      .toBe(true);
  });

  it("accepts a progress chunk larger than 16 KiB when every line is bounded", async () => {
    const sourcePath = await sourceFile("large-progress.mov", "large-progress");
    const authorized = await inputs.authorize(OWNER_A, sourcePath);
    await commitTaskLease(OWNER_A, authorized.fileToken, "task-large-progress");
    const progressChunk = `${"out_time_us=1000\n".repeat(1_100)}progress=end\n`;
    expect(Buffer.byteLength(progressChunk)).toBeGreaterThan(16 * 1024);
    const harness = createHarness({ progressChunks: [progressChunk] });

    await expect(
      harness.normalizer.normalizeTask({
        owner: OWNER_A,
        fileToken: authorized.fileToken,
        taskId: "task-large-progress",
        taskGeneration: 1,
      }),
    ).resolves.toMatchObject({ taskId: "task-large-progress" });
  });

  it("parses split CRLF progress and falls back from zero time to total_size", async () => {
    const sourcePath = await sourceFile("size-progress.mov", "size-progress");
    const authorized = await inputs.authorize(OWNER_A, sourcePath);
    await commitTaskLease(OWNER_A, authorized.fileToken, "task-size-progress");
    const harness = createHarness({
      progressChunks: [
        "out_time_us=0\r",
        "\ntotal_size=160000\r",
        "\nprogress=end\r",
        "\n",
      ],
    });
    const progress: number[] = [];

    await harness.normalizer.normalizeTask({
      owner: OWNER_A,
      fileToken: authorized.fileToken,
      taskId: "task-size-progress",
      taskGeneration: 1,
      onProgress: (value) => progress.push(value),
    });

    expect(harness.decodeCalls[0]!.stdoutMode).toBe("stream");
    expect(progress[0]).toBe(10);
    expect(progress.some((value) => value > 10 && value < 100)).toBe(true);
    expect(progress.at(-1)).toBe(100);
  });

  it("absorbs rejected async progress observers without changing normalization", async () => {
    const sourcePath = await sourceFile("async-progress.mov", "async-progress");
    const authorized = await inputs.authorize(OWNER_A, sourcePath);
    await commitTaskLease(OWNER_A, authorized.fileToken, "task-async-progress");
    const harness = createHarness();
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);
    try {
      await expect(
        harness.normalizer.normalizeTask({
          owner: OWNER_A,
          fileToken: authorized.fileToken,
          taskId: "task-async-progress",
          taskGeneration: 1,
          onProgress: async () => {
            throw new Error("progress observer failure");
          },
        }),
      ).resolves.toMatchObject({ taskId: "task-async-progress" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejection);
    }
  });
});

describe("local subtitle PCM proof, window integrity, and cleanup", () => {
  it("rejects cloned normalized and window proofs while resolving exact hash bytes", async () => {
    const { harness, normalized } = await normalizedFixture(
      OWNER_A,
      "proof.mov",
      "task-proof",
    );
    const descriptor = structuralWindow(0, 16_000);
    const clonedNormalized = { ...normalized };

    expect(isLocalSubtitleNormalizedPcm(clonedNormalized)).toBe(false);
    await expect(
      harness.normalizer.materializeWindow({
        normalized: clonedNormalized,
        descriptor,
      }),
    ).rejects.toMatchObject({
      code: "invalid_configuration",
      localSubtitleCode: "runtime_protocol_mismatch",
    });

    const window = await harness.normalizer.materializeWindow({
      normalized,
      descriptor,
    });
    const clonedWindow = { ...window };
    expect(isLocalSubtitleBrandedPcmWindow(window)).toBe(true);
    expect(isLocalSubtitleBrandedPcmWindow(clonedWindow)).toBe(false);
    expect(Object.isFrozen(window)).toBe(true);
    expect(Object.isFrozen(window.descriptor)).toBe(true);
    expect(JSON.stringify(window)).not.toContain(managedRoot);
    await expect(
      harness.normalizer.resolveWindow(clonedWindow, {
        taskId: "task-proof",
        taskGeneration: 1,
        descriptor,
      }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });

    const resolved = await harness.normalizer.resolveWindow(window, {
      taskId: "task-proof",
      taskGeneration: 1,
      descriptor,
    });
    const bytes = await readFile(resolved.filePath);
    expect(resolved.byteSize).toBe(bytes.length);
    expect(resolved.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(window.sha256).toBe(resolved.sha256);
    expect(window.frameCount).toBe(16_000);
    expect(window.durationMs).toBe(1_000);

    await expect(harness.normalizer.disposeWindow(window)).resolves.toEqual({
      removed: true,
    });
    await expect(harness.normalizer.disposeWindow(window)).resolves.toEqual({
      removed: false,
    });
    expect(isLocalSubtitleBrandedPcmWindow(window)).toBe(false);
  });

  it("detects a branded window changed through its previously resolved path", async () => {
    const { harness, normalized } = await normalizedFixture(
      OWNER_A,
      "changed-window.mov",
      "task-changed-window",
    );
    const descriptor = structuralWindow(0, 8_000);
    const window = await harness.normalizer.materializeWindow({
      normalized,
      descriptor,
    });
    const expected = {
      taskId: "task-changed-window",
      taskGeneration: 1,
      descriptor,
    } as const;
    const resolved = await harness.normalizer.resolveWindow(window, expected);
    const originalBytes = await readFile(resolved.filePath);
    const handle = await open(resolved.filePath, "r+");
    try {
      await handle.write(Buffer.from([0x7f]), 0, 1, 44);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await expect(
      harness.normalizer.resolveWindow(window, expected),
    ).rejects.toMatchObject({
      code: "media_changed",
      localSubtitleCode: "media_changed",
    });
    expect(isLocalSubtitleBrandedPcmWindow(window)).toBe(false);

    await writeFile(resolved.filePath, originalBytes);
    expect(isLocalSubtitleBrandedPcmWindow(window)).toBe(false);
    await expect(
      harness.normalizer.resolveWindow(window, expected),
    ).rejects.toMatchObject({ code: "invalid_configuration" });

    const headerDescriptor = structuralWindow(8_000, 16_000);
    const headerWindow = await harness.normalizer.materializeWindow({
      normalized,
      descriptor: headerDescriptor,
    });
    const headerExpected = {
      taskId: "task-changed-window",
      taskGeneration: 1,
      descriptor: headerDescriptor,
    } as const;
    const headerResolved = await harness.normalizer.resolveWindow(
      headerWindow,
      headerExpected,
    );
    const headerBytes = await readFile(headerResolved.filePath);
    const headerHandle = await open(headerResolved.filePath, "r+");
    try {
      await headerHandle.write(Buffer.from("NOPE"), 0, 4, 0);
      await headerHandle.sync();
    } finally {
      await headerHandle.close();
    }

    await expect(
      harness.normalizer.resolveWindow(headerWindow, headerExpected),
    ).rejects.toMatchObject({
      code: "media_changed",
      localSubtitleCode: "media_changed",
    });
    expect(isLocalSubtitleBrandedPcmWindow(headerWindow)).toBe(false);
    await writeFile(headerResolved.filePath, headerBytes);
    expect(isLocalSubtitleBrandedPcmWindow(headerWindow)).toBe(false);
    await expect(
      harness.normalizer.resolveWindow(headerWindow, headerExpected),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
  });

  it("permanently invalidates existing windows when the normalized source faults", async () => {
    const { harness, normalized } = await normalizedFixture(
      OWNER_A,
      "faulted-normalized.mov",
      "task-faulted-normalized",
    );
    const firstDescriptor = structuralWindow(0, 8_000);
    const firstWindow = await harness.normalizer.materializeWindow({
      normalized,
      descriptor: firstDescriptor,
    });
    const resolved = await harness.normalizer.resolveWindow(firstWindow, {
      taskId: "task-faulted-normalized",
      taskGeneration: 1,
      descriptor: firstDescriptor,
    });
    const normalizedPath = path.join(path.dirname(resolved.filePath), "normalized.wav");
    const originalBytes = await readFile(normalizedPath);
    await writeFile(normalizedPath, Buffer.from(originalBytes).fill(0x55, 44, 45));

    await expect(
      harness.normalizer.materializeWindow({
        normalized,
        descriptor: structuralWindow(8_000, 16_000),
      }),
    ).rejects.toMatchObject({ code: "decode_failed" });
    expect(isLocalSubtitleNormalizedPcm(normalized)).toBe(false);
    expect(isLocalSubtitleBrandedPcmWindow(firstWindow)).toBe(false);

    await writeFile(normalizedPath, originalBytes);
    expect(isLocalSubtitleNormalizedPcm(normalized)).toBe(false);
    expect(isLocalSubtitleBrandedPcmWindow(firstWindow)).toBe(false);
    await expect(
      harness.normalizer.resolveWindow(firstWindow, {
        taskId: "task-faulted-normalized",
        taskGeneration: 1,
        descriptor: firstDescriptor,
      }),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
  });

  it("materializes multiple exact windows without decoding the source again", async () => {
    const { harness, normalized } = await normalizedFixture(
      OWNER_A,
      "multi-window.mov",
      "task-multi-window",
    );

    await harness.normalizer.materializeWindow({
      normalized,
      descriptor: structuralWindow(0, 16_000),
    });
    await harness.normalizer.materializeWindow({
      normalized,
      descriptor: structuralWindow(16_000, 32_000),
    });

    expect(harness.decodeCount).toBe(1);
  });

  it("binds odd half-millisecond descriptors to exact frame duration", async () => {
    const { harness, normalized } = await normalizedFixture(
      OWNER_A,
      "half-millisecond.mov",
      "task-half-millisecond",
    );
    const descriptor = structuralWindow(8, 16_008);
    const window = await harness.normalizer.materializeWindow({
      normalized,
      descriptor,
    });

    expect(window.descriptor).toMatchObject({
      startFrame: 8,
      endFrame: 16_008,
      startMs: 1,
      endMs: 1_001,
    });
    expect(window.frameCount).toBe(16_000);
    expect(window.durationMs).toBe(1_000);
    await expect(
      harness.normalizer.resolveWindow(window, {
        taskId: "task-half-millisecond",
        taskGeneration: 1,
        descriptor,
      }),
    ).resolves.toMatchObject({ sha256: window.sha256 });
  });

  it.each([
    {
      label: "abort",
      result: closedResult(Buffer.alloc(0), {
        exitCode: null,
        signalCode: "SIGTERM",
        aborted: true,
      }),
      expectedCode: "aborted",
    },
    {
      label: "decode failure",
      result: closedResult(Buffer.alloc(0), { exitCode: 1 }),
      expectedCode: "decode_failed",
    },
  ])("removes the complete media session after $label", async ({ result, expectedCode }) => {
    const sourcePath = await sourceFile("failed.mov", "failed");
    const authorized = await inputs.authorize(OWNER_A, sourcePath);
    await commitTaskLease(OWNER_A, authorized.fileToken, "task-failed");
    const controller = new AbortController();
    const harness = createHarness({
      afterDecodeOutput: async () => {
        if (expectedCode === "aborted") controller.abort();
      },
      decodeResult: result,
    });

    await expect(
      harness.normalizer.normalizeTask({
        owner: OWNER_A,
        fileToken: authorized.fileToken,
        taskId: "task-failed",
        taskGeneration: 1,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: expectedCode,
      localSubtitleCode: "media_decode_failed",
    });
    expect(harness.decodeCount).toBe(1);
    await expect(mediaSessions()).resolves.toEqual([]);
  });

  it("fails promptly but retains the session until an unconfirmed child closes", async () => {
    const sourcePath = await sourceFile("late-close.mov", "late-close");
    const nextSourcePath = await sourceFile("after-late-close.mov", "after-late-close");
    const authorized = await inputs.authorize(OWNER_A, sourcePath);
    const nextAuthorized = await inputs.authorize(OWNER_A, nextSourcePath);
    await commitTaskLease(OWNER_A, authorized.fileToken, "task-late-close");
    const close = deferred<void>();
    const harness = createHarness({
      decodeResult: closedResult(Buffer.alloc(0), {
        status: "close_unconfirmed",
        exitCode: null,
        timedOut: true,
        closeConfirmed: close.promise,
      }),
    });
    const pending = harness.normalizer.normalizeTask({
      owner: OWNER_A,
      fileToken: authorized.fileToken,
      taskId: "task-late-close",
      taskGeneration: 1,
    });
    const rejection = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await waitForCondition(async () =>
      harness.decodeCount === 1 && (await mediaSessions()).length === 1,
    );
    await rejection;
    await expect(mediaSessions()).resolves.toHaveLength(1);
    await expect(
      harness.normalizer.probeDraft({
        owner: OWNER_A,
        fileToken: nextAuthorized.fileToken,
      }),
    ).rejects.toMatchObject({
      code: "runtime_launch_failed",
      localSubtitleCode: "media_runtime_launch_failed",
    });

    close.resolve();
    await waitForCondition(async () => (await mediaSessions()).length === 0);
    await expect(
      harness.normalizer.probeDraft({
        owner: OWNER_A,
        fileToken: nextAuthorized.fileToken,
      }),
    ).resolves.toMatchObject({ durationMs: 10_000 });
  });

  it("faults an owner after failed session cleanup and retries only during shutdown", async () => {
    const sourcePath = await sourceFile("cleanup-fault.mov", "cleanup-fault");
    const nextSourcePath = await sourceFile("cleanup-fenced.mov", "cleanup-fenced");
    const authorized = await inputs.authorize(OWNER_A, sourcePath);
    const nextAuthorized = await inputs.authorize(OWNER_A, nextSourcePath);
    await commitTaskLease(OWNER_A, authorized.fileToken, "task-cleanup-fault");
    let sessionRoot = "";
    let displacedSession = "";
    const harness = createHarness({
      decodeResult: closedResult(Buffer.alloc(0), { exitCode: 1 }),
      afterDecodeOutput: async ({ outputPath }) => {
        sessionRoot = path.dirname(outputPath);
        displacedSession = `${sessionRoot}.displaced`;
        await rename(sessionRoot, displacedSession);
        await mkdir(sessionRoot, { mode: 0o700 });
      },
    });

    await expect(
      harness.normalizer.normalizeTask({
        owner: OWNER_A,
        fileToken: authorized.fileToken,
        taskId: "task-cleanup-fault",
        taskGeneration: 1,
      }),
    ).rejects.toMatchObject({
      code: "cleanup_failed",
      localSubtitleCode: "cleanup_failed",
      stage: "cleanup",
    });
    await expect(
      harness.normalizer.probeDraft({
        owner: OWNER_A,
        fileToken: nextAuthorized.fileToken,
      }),
    ).rejects.toMatchObject({
      code: "cleanup_failed",
      localSubtitleCode: "cleanup_failed",
    });

    await rm(sessionRoot, { recursive: true, force: false });
    await rename(displacedSession, sessionRoot);
    await expect(harness.normalizer.shutdown("fatal")).resolves.toBeUndefined();
    await expect(mediaSessions()).resolves.toEqual([]);
  });

  it("invalidates existing proofs when a later task session cannot be cleaned", async () => {
    let sabotageCleanup = false;
    let failedSession = "";
    let displacedSession = "";
    const harness = createHarness({
      decodeResult: () =>
        sabotageCleanup
          ? closedResult(Buffer.alloc(0), { exitCode: 1 })
          : closedResult(),
      afterDecodeOutput: async ({ outputPath }) => {
        if (!sabotageCleanup) return;
        failedSession = path.dirname(outputPath);
        displacedSession = `${failedSession}.displaced`;
        await rename(failedSession, displacedSession);
        await mkdir(failedSession, { mode: 0o700 });
      },
    });
    const normalized = await normalizeSource(
      harness,
      OWNER_A,
      "proof-before-cleanup-fault.mov",
      "task-proof-before-cleanup-fault",
    );
    const descriptor = structuralWindow(0, 4_000);
    const window = await harness.normalizer.materializeWindow({
      normalized,
      descriptor,
    });
    expect(isLocalSubtitleNormalizedPcm(normalized)).toBe(true);
    expect(isLocalSubtitleBrandedPcmWindow(window)).toBe(true);

    sabotageCleanup = true;
    const failingSource = await sourceFile(
      "later-cleanup-fault.mov",
      "later-cleanup-fault",
    );
    const failingAuthorization = await inputs.authorize(OWNER_A, failingSource);
    await commitTaskLease(
      OWNER_A,
      failingAuthorization.fileToken,
      "task-later-cleanup-fault",
    );
    await expect(
      harness.normalizer.normalizeTask({
        owner: OWNER_A,
        fileToken: failingAuthorization.fileToken,
        taskId: "task-later-cleanup-fault",
        taskGeneration: 1,
      }),
    ).rejects.toMatchObject({
      code: "cleanup_failed",
      localSubtitleCode: "cleanup_failed",
    });
    expect(isLocalSubtitleNormalizedPcm(normalized)).toBe(false);
    expect(isLocalSubtitleBrandedPcmWindow(window)).toBe(false);

    await rm(failedSession, { recursive: true, force: false });
    await rename(displacedSession, failedSession);
    await expect(harness.normalizer.shutdown("fatal")).resolves.toBeUndefined();
    await expect(mediaSessions()).resolves.toEqual([]);
  });

  it("releaseOwner removes only owned sessions and invalidates every proof", async () => {
    const harness = createHarness();
    const normalizedA = await normalizeSource(
      harness,
      OWNER_A,
      "release-a.mov",
      "task-release-a",
    );
    const normalizedB = await normalizeSource(
      harness,
      OWNER_B,
      "release-b.mov",
      "task-release-b",
    );
    const descriptor = structuralWindow(0, 4_000);
    const windowA = await harness.normalizer.materializeWindow({
      normalized: normalizedA,
      descriptor,
    });
    const windowB = await harness.normalizer.materializeWindow({
      normalized: normalizedB,
      descriptor,
    });
    expect(await mediaSessions()).toHaveLength(2);

    harness.normalizer.releaseOwner(OWNER_A);

    expect(isLocalSubtitleNormalizedPcm(normalizedA)).toBe(false);
    expect(isLocalSubtitleBrandedPcmWindow(windowA)).toBe(false);

    await expect(
      harness.normalizer.resolveWindow(windowA, {
        taskId: "task-release-a",
        taskGeneration: 1,
        descriptor,
      }),
    ).rejects.toMatchObject({ localSubtitleCode: "owner_released" });
    await waitForCondition(async () => (await mediaSessions()).length === 1);
    expect(isLocalSubtitleNormalizedPcm(normalizedB)).toBe(true);
    expect(isLocalSubtitleBrandedPcmWindow(windowB)).toBe(true);
    await expect(
      harness.normalizer.resolveWindow(windowB, {
        taskId: "task-release-b",
        taskGeneration: 1,
        descriptor,
      }),
    ).resolves.toMatchObject({ sha256: windowB.sha256 });
    expect(await mediaSessions()).toHaveLength(1);

    harness.normalizer.releaseOwner(OWNER_B);
    await waitForCondition(
      async () =>
        !isLocalSubtitleNormalizedPcm(normalizedB) &&
        !isLocalSubtitleBrandedPcmWindow(windowB) &&
        (await mediaSessions()).length === 0,
    );
    await expect(mediaSessions()).resolves.toEqual([]);
  });

  it("shares terminal shutdown, cleans proofs, and rejects future owners", async () => {
    const harness = createHarness();
    const normalized = await normalizeSource(
      harness,
      OWNER_A,
      "shutdown.mov",
      "task-shutdown",
    );
    expect(isLocalSubtitleNormalizedPcm(normalized)).toBe(true);

    const first = harness.normalizer.shutdown("update");
    const second = harness.normalizer.shutdown("fatal");
    expect(first).toBe(second);
    expect(isLocalSubtitleNormalizedPcm(normalized)).toBe(false);
    await first;

    expect(isLocalSubtitleNormalizedPcm(normalized)).toBe(false);
    await expect(mediaSessions()).resolves.toEqual([]);
    await expect(
      harness.normalizer.probeDraft({
        owner: OWNER_B,
        fileToken: "future-owner-token",
      }),
    ).rejects.toMatchObject({ localSubtitleCode: "owner_released" });
    await expect(harness.normalizer.shutdown("app_quit")).resolves.toBeUndefined();
  });

  it("continues other owner cleanup when one owner fails and supports a later retry", async () => {
    const harness = createHarness();
    const normalizedA = await normalizeSource(
      harness,
      OWNER_A,
      "shutdown-failure-a.mov",
      "task-shutdown-failure-a",
    );
    const normalizedB = await normalizeSource(
      harness,
      OWNER_B,
      "shutdown-failure-b.mov",
      "task-shutdown-failure-b",
    );
    const descriptor = structuralWindow(0, 4_000);
    const windowA = await harness.normalizer.materializeWindow({
      normalized: normalizedA,
      descriptor,
    });
    const windowB = await harness.normalizer.materializeWindow({
      normalized: normalizedB,
      descriptor,
    });
    const resolvedA = await harness.normalizer.resolveWindow(windowA, {
      taskId: "task-shutdown-failure-a",
      taskGeneration: 1,
      descriptor,
    });
    const resolvedB = await harness.normalizer.resolveWindow(windowB, {
      taskId: "task-shutdown-failure-b",
      taskGeneration: 1,
      descriptor,
    });
    const sessionA = path.dirname(resolvedA.filePath);
    const sessionB = path.dirname(resolvedB.filePath);
    const displacedA = `${sessionA}.displaced`;
    await rename(sessionA, displacedA);
    await mkdir(sessionA, { mode: 0o700 });

    await expect(harness.normalizer.shutdown("update")).rejects.toMatchObject({
      code: "cleanup_failed",
      localSubtitleCode: "cleanup_failed",
    });
    await expect(lstat(displacedA)).resolves.toMatchObject({});
    await expect(lstat(sessionB)).rejects.toMatchObject({ code: "ENOENT" });

    await rm(sessionA, { recursive: true, force: false });
    await rename(displacedA, sessionA);
    await expect(harness.normalizer.shutdown("update")).resolves.toBeUndefined();
    await expect(mediaSessions()).resolves.toEqual([]);
  });
});

interface ProbeTrackFixture {
  readonly index: number;
  readonly codec_type: "audio";
  readonly codec_name: string;
  readonly channels: number;
  readonly sample_rate: string;
  readonly duration: string;
  readonly disposition: { readonly default: 0 | 1 };
  readonly tags: Readonly<Record<string, unknown>>;
}

type FakeCallKind =
  | "ffmpeg-version"
  | "ffprobe-version"
  | "media-probe"
  | "decode";

interface CapturedMediaCall {
  readonly kind: FakeCallKind;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdoutMode?: "capture" | "stream";
}

interface DecodeContext {
  readonly request: LocalSubtitleMediaProcessRequest;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly inputBytes: Buffer;
}

interface FakeHarnessOptions {
  readonly versionText?: Partial<Record<"ffmpeg" | "ffprobe", string>>;
  readonly probeOutputs?: readonly unknown[];
  readonly progressChunks?: readonly string[];
  readonly decodedFrames?: number;
  readonly decodeResult?:
    | LocalSubtitleMediaProcessResult
    | ((context: DecodeContext) => LocalSubtitleMediaProcessResult);
  readonly managedResourceRoot?: string;
  readonly afterMediaProbe?: (inputPath: string) => Promise<void> | void;
  readonly afterDecodeOutput?: (context: DecodeContext) => Promise<void> | void;
  readonly yieldEveryCall?: boolean;
  readonly waitForAbortKind?: FakeCallKind;
}

function createHarness(options: FakeHarnessOptions = {}) {
  const calls: CapturedMediaCall[] = [];
  const decodeInputPaths: string[] = [];
  const decodeInputBytes: Buffer[] = [];
  const mediaProbePaths: string[] = [];
  let probeIndex = 0;
  let decodeCount = 0;
  let active = 0;
  let maxActive = 0;

  const runner: LocalSubtitleMediaCommandRunner = vi.fn(
    async (request: LocalSubtitleMediaProcessRequest) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const kind = classifyCall(request);
      calls.push({
        kind,
        command: request.command,
        args: Object.freeze([...request.args]),
        cwd: request.cwd,
        env: Object.freeze({ ...request.env }),
        ...(request.stdoutMode === undefined
          ? {}
          : { stdoutMode: request.stdoutMode }),
      });
      try {
        if (options.yieldEveryCall) await Promise.resolve();
        if (options.waitForAbortKind === kind) {
          await waitForAbort(request.signal);
          return closedResult(Buffer.alloc(0), {
            exitCode: null,
            signalCode: "SIGTERM",
            aborted: true,
          });
        }
        if (kind === "ffmpeg-version" || kind === "ffprobe-version") {
          const executable = kind === "ffmpeg-version" ? "ffmpeg" : "ffprobe";
          const version = runtime.manifest.artifacts.find(
            (artifact) => artifact.kind === executable,
          )!.version;
          return closedResult(
            Buffer.from(
              options.versionText?.[executable] ??
                `${executable} version ${version}\n`,
            ),
          );
        }
        if (kind === "media-probe") {
          const inputPath = request.args.at(-1)!;
          mediaProbePaths.push(inputPath);
          const outputs = options.probeOutputs ?? [probePayload([probeTrack(0, true)])];
          const output = outputs[Math.min(probeIndex, outputs.length - 1)]!;
          probeIndex += 1;
          await options.afterMediaProbe?.(inputPath);
          return closedResult(Buffer.from(JSON.stringify(output)));
        }

        decodeCount += 1;
        const inputIndex = request.args.indexOf("-i");
        const inputPath = request.args[inputIndex + 1]!;
        const outputPath = request.args.at(-1)!;
        const inputBytes = await readFile(inputPath);
        decodeInputPaths.push(inputPath);
        decodeInputBytes.push(inputBytes);
        const frames = options.decodedFrames ?? 160_000;
        const payload = Buffer.alloc(frames * 2, 0x2a);
        await writeFile(
          outputPath,
          Buffer.concat([
            createLocalSubtitlePcm16WavHeader(payload.length),
            payload,
          ]),
          { mode: 0o600 },
        );
        for (const chunk of options.progressChunks ?? ["progress=end\n"]) {
          request.onStdoutChunk?.(Buffer.from(chunk));
        }
        const context = { request, inputPath, outputPath, inputBytes };
        await options.afterDecodeOutput?.(context);
        return (
          (typeof options.decodeResult === "function"
            ? options.decodeResult(context)
            : options.decodeResult) ?? closedResult()
        );
      } finally {
        active -= 1;
      }
    },
  );

  const normalizer = new LocalSubtitleMediaNormalizer({
    environment: runtime.environment,
    managedResourceRoot: options.managedResourceRoot ?? managedRoot,
    inputAuthorizations: inputs,
    processRunner: runner,
    signatureVerifier: async () => true,
    tokenFactory: sequence("media"),
    sourceEnvironment: {
      PATH: "/untrusted/bin",
      SECRET_MEDIA_TOKEN: "do-not-inherit",
      HTTPS_PROXY: "https://private.invalid",
    },
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
  });

  return {
    normalizer,
    calls,
    decodeInputPaths,
    decodeInputBytes,
    mediaProbePaths,
    get decodeCalls() {
      return calls.filter((call) => call.kind === "decode");
    },
    get decodeCount() {
      return decodeCount;
    },
    get maxActive() {
      return maxActive;
    },
  };
}

function classifyCall(request: LocalSubtitleMediaProcessRequest): FakeCallKind {
  const ffmpegPath = runtime.artifactPaths[artifactId("ffmpeg")];
  const ffprobePath = runtime.artifactPaths[artifactId("ffprobe")];
  if (request.args.includes("-version")) {
    if (request.command === ffmpegPath) return "ffmpeg-version";
    if (request.command === ffprobePath) return "ffprobe-version";
  }
  if (request.command === ffprobePath && request.args.includes("-show_entries")) {
    return "media-probe";
  }
  if (request.command === ffmpegPath && request.args.includes("-progress")) {
    return "decode";
  }
  throw new Error("Unexpected media process contract.");
}

function artifactId(kind: "ffmpeg" | "ffprobe"): string {
  return runtime.manifest.artifacts.find((artifact) => artifact.kind === kind)!.id;
}

function closedResult(
  stdout: Buffer = Buffer.alloc(0),
  overrides: Partial<LocalSubtitleMediaProcessResult> = {},
): LocalSubtitleMediaProcessResult {
  return Object.freeze({
    status: "closed" as const,
    spawned: true,
    exitCode: 0,
    signalCode: null,
    stdout,
    stderr: Buffer.alloc(0),
    aborted: false,
    timedOut: false,
    outputExceeded: false,
    closeConfirmed: Promise.resolve(),
    ...overrides,
  });
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function probeTrack(index: number, isDefault = false): ProbeTrackFixture {
  return {
    index,
    codec_type: "audio",
    codec_name: "aac",
    channels: 2,
    sample_rate: "48000",
    duration: "10.000",
    disposition: { default: isDefault ? 1 : 0 },
    tags: { language: "ja", title: `Track ${index}` },
  };
}

function probePayload(
  tracks: readonly ProbeTrackFixture[],
  duration = "10.000",
) {
  return {
    streams: tracks,
    format: { duration },
  };
}

async function sourceFile(
  leaf: string,
  value: string | Buffer,
): Promise<string> {
  const filePath = path.join(sourceRoot, leaf);
  await writeFile(filePath, value);
  return filePath;
}

async function commitTaskLease(
  owner: LocalSubtitleOwnerKey,
  fileToken: string,
  taskId: string,
): Promise<void> {
  const transaction = await new LocalSubtitleCapabilityLeaseCoordinator(
    inputs,
    new LocalSubtitleOutputDirectoryAuthorizationRegistry(),
    { reservationIdFactory: () => `reservation-${taskId}` },
  ).reserveBatch({
    owner,
    batchId: `batch-${taskId}`,
    inputs: [{ fileToken, taskId }],
  });
  transaction.commit();
}

async function normalizeSource(
  harness: ReturnType<typeof createHarness>,
  owner: LocalSubtitleOwnerKey,
  leaf: string,
  taskId: string,
) {
  const sourcePath = await sourceFile(leaf, `source-${taskId}`);
  const authorized = await inputs.authorize(owner, sourcePath);
  await commitTaskLease(owner, authorized.fileToken, taskId);
  return harness.normalizer.normalizeTask({
    owner,
    fileToken: authorized.fileToken,
    taskId,
    taskGeneration: 1,
  });
}

async function normalizedFixture(
  owner: LocalSubtitleOwnerKey,
  leaf: string,
  taskId: string,
) {
  const harness = createHarness();
  const normalized = await normalizeSource(harness, owner, leaf, taskId);
  return { harness, normalized };
}

function structuralWindow(
  startFrame: number,
  endFrame: number,
): LocalSubtitleMediaStructuralWindow {
  const startMs = Math.round((startFrame * 1_000) / 16_000);
  const endMs = Math.round((endFrame * 1_000) / 16_000);
  return Object.freeze({
    windowKey: `window-${startFrame}-${endFrame}`,
    rootPlanId: "root-plan-1",
    rootWindowKey: "root-window-1",
    retryDepth: 0,
    startFrame,
    endFrame,
    coreStartFrame: startFrame,
    coreEndFrame: endFrame,
    startMs,
    endMs,
    coreStartMs: startMs,
    coreEndMs: endMs,
  });
}

async function padRiffWithJunk(
  filePath: string,
  targetSize: number,
): Promise<void> {
  const wav = await readFile(filePath);
  const payloadSize = targetSize - wav.length - 8;
  if (payloadSize <= 0 || payloadSize % 2 !== 0) {
    throw new Error("The RIFF padding fixture size is invalid.");
  }
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write("JUNK", 0, "ascii");
  chunkHeader.writeUInt32LE(payloadSize, 4);
  const expanded = Buffer.concat([wav, chunkHeader, Buffer.alloc(payloadSize)]);
  expanded.writeUInt32LE(expanded.length - 8, 4);
  await writeFile(filePath, expanded);
}

async function overwriteWithSparseRf64(
  filePath: string,
  totalFrames: number,
): Promise<void> {
  const dataSize = totalFrames * 2;
  const fileSize = 80 + dataSize;
  const header = Buffer.alloc(80);
  const canonicalHeader = createLocalSubtitlePcm16WavHeader(2);
  header.write("RF64", 0, "ascii");
  header.writeUInt32LE(0xffff_ffff, 4);
  header.write("WAVE", 8, "ascii");
  header.write("ds64", 12, "ascii");
  header.writeUInt32LE(28, 16);
  header.writeBigUInt64LE(BigInt(fileSize - 8), 20);
  header.writeBigUInt64LE(BigInt(dataSize), 28);
  header.writeBigUInt64LE(BigInt(totalFrames), 36);
  header.writeUInt32LE(0, 44);
  header.write("fmt ", 48, "ascii");
  header.writeUInt32LE(16, 52);
  canonicalHeader.copy(header, 56, 20, 36);
  header.write("data", 72, "ascii");
  header.writeUInt32LE(0xffff_ffff, 76);

  const handle = await open(filePath, "r+");
  try {
    await handle.write(header, 0, header.length, 0);
    await handle.truncate(fileSize);
  } finally {
    await handle.close();
  }
}

async function mediaSessions(): Promise<string[]> {
  const base = path.join(managedRoot, "temp", "media");
  try {
    return (await readdir(base))
      .filter((entry) => entry.startsWith("media-"))
      .map((entry) => path.join(base, entry))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for media cleanup.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sequence(prefix: string): () => string {
  let index = 0;
  return () => `${prefix}-${++index}`;
}
