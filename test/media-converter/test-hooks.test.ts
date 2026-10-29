import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MEDIA_TEST_HOOK_LIMITS, TEST_MEDIA_CAPS_ENV, isMediaTestBuild, parseMediaCapsOverride, resolveMediaTestHooks,
  type MediaTestEnvironment,
} from '../../electron/main/media-converter/test-hooks';
import { MediaCapabilities, type CapabilityRuntime } from '../../electron/main/media-converter/engine/capabilities';
import type { MediaRunResult, MediaTools } from '../../electron/main/media-converter/engine/runtime';

/**
 * FUSIONKIT_TEST_MEDIA_CAPS (module-engine design §9): read only under NODE_ENV=test in an
 * unpackaged run, the gate of the repository's other FUSIONKIT_TEST_* switches. Nothing here runs
 * ffmpeg: the runtime is a recording double.
 */

const testEnv = (value?: string): MediaTestEnvironment => ({ NODE_ENV: 'test', ...(value === undefined ? {} : { [TEST_MEDIA_CAPS_ENV]: value }) });

describe('the test build gate', () => {
  it('is a test build only with NODE_ENV=test and not packaged', () => {
    expect(isMediaTestBuild({ NODE_ENV: 'test' }, { packaged: false })).toBe(true);
    expect(isMediaTestBuild({ NODE_ENV: 'test' }, { packaged: true })).toBe(false);
    expect(isMediaTestBuild({ NODE_ENV: 'production' }, { packaged: false })).toBe(false);
    expect(isMediaTestBuild({}, { packaged: false })).toBe(false);
  });

  it('ignores FUSIONKIT_TEST_MEDIA_CAPS in a packaged build, whatever the environment says', () => {
    for (const value of ['cpu_only', 'nvenc', 'unavailable:runtime_invalid', 'detecting_ms:5000']) {
      expect(resolveMediaTestHooks(testEnv(value), { packaged: true }).caps).toBeNull();
      expect(resolveMediaTestHooks(testEnv(value), { packaged: false }).caps).not.toBeNull();
    }
  });

  it('ignores it outside NODE_ENV=test', () => {
    expect(resolveMediaTestHooks({ NODE_ENV: 'development', [TEST_MEDIA_CAPS_ENV]: 'cpu_only' }, { packaged: false }).caps).toBeNull();
    expect(resolveMediaTestHooks({ [TEST_MEDIA_CAPS_ENV]: 'nvenc' }, { packaged: false }).caps).toBeNull();
  });
});

describe('FUSIONKIT_TEST_MEDIA_CAPS values', () => {
  it('reads the four forms of design §9', () => {
    expect(parseMediaCapsOverride('cpu_only')).toEqual({ kind: 'cpu_only' });
    expect(parseMediaCapsOverride('nvenc')).toEqual({ kind: 'nvenc' });
    expect(parseMediaCapsOverride('unavailable:runtime_invalid')).toEqual({ kind: 'unavailable', code: 'runtime_invalid' });
    expect(parseMediaCapsOverride('unavailable:driver_too_old')).toEqual({ kind: 'unavailable', code: 'driver_too_old' });
    expect(parseMediaCapsOverride('detecting_ms:1500')).toEqual({ kind: 'detecting', milliseconds: 1500 });
    expect(parseMediaCapsOverride(' detecting_ms:0 ')).toEqual({ kind: 'detecting', milliseconds: 0 });
    expect(parseMediaCapsOverride(`detecting_ms:${MEDIA_TEST_HOOK_LIMITS.maxDetectingMs}`)).toEqual({ kind: 'detecting', milliseconds: MEDIA_TEST_HOOK_LIMITS.maxDetectingMs });
  });

  it('treats anything else as unset', () => {
    for (const value of [undefined, '', 'CPU_ONLY', 'gpu', 'unavailable', 'unavailable:', 'unavailable:not_a_code', 'unavailable:Runtime_invalid',
      'detecting_ms', 'detecting_ms:', 'detecting_ms:-1', 'detecting_ms:1.5', 'detecting_ms:abc', `detecting_ms:${MEDIA_TEST_HOOK_LIMITS.maxDetectingMs + 1}`,
      'detecting_ms:9999999999', 'nvenc,cpu_only']) {
      expect(parseMediaCapsOverride(value), String(value)).toBeNull();
      expect(resolveMediaTestHooks(testEnv(value), { packaged: false }).caps, String(value)).toBeNull();
    }
  });
});

describe('the switch in the capability detection', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'fk-media-hooks-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  /** A runtime whose every run is recorded and answered as a failed encode; the listings it is asked for are empty, so a real detection stops at them. */
  function recordingRuntime() {
    const runs: string[][] = [];
    const tools: MediaTools = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', version: 'n8.1.2', generation: 'g'.repeat(64), environment: {}, workingDirectory: path.join(root, 'work') };
    const runtime: CapabilityRuntime = {
      acquire: async () => tools,
      status: () => ({ state: 'ready', version: 'n8.1.2' }),
      run: async (_tool, args) => {
        runs.push([...args]);
        return { status: 'closed', spawned: true, exitCode: 0, signalCode: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), aborted: false,
          timedOut: false, outputExceeded: false, closeConfirmed: Promise.resolve() } satisfies MediaRunResult;
      },
    };
    return { runtime, runs };
  }

  it('replaces the detection in a test build and is ignored by a packaged one', async () => {
    const test = recordingRuntime();
    const overridden = new MediaCapabilities({ runtime: test.runtime, root, gpuInfo: async () => null, isHardwareEncodeRunning: () => false, override: resolveMediaTestHooks(testEnv('nvenc'), { packaged: false }).caps });
    const answer = await overridden.planner();
    expect(answer.ok).toBe(true);
    expect(test.runs).toEqual([]);
    expect(overridden.status().capabilities).toMatchObject({ state: 'ready', hardwareEncoders: ['av1_nvenc', 'hevc_nvenc', 'h264_nvenc'] });
    expect(await readdir(root)).toEqual([]);

    // The same environment in an installed build: the real detection runs (here it stops at the empty encoder list).
    const packaged = recordingRuntime();
    const real = new MediaCapabilities({ runtime: packaged.runtime, root, gpuInfo: async () => null, isHardwareEncodeRunning: () => false, log: () => {},
      override: resolveMediaTestHooks(testEnv('nvenc'), { packaged: true }).caps });
    expect(await real.planner()).toEqual({ ok: false, code: 'runtime_invalid' });
    expect(packaged.runs.map(args => args.at(-1))).toEqual(['-encoders', '-muxers', '-filters']);
  });

  it('unavailable:<code> answers that code without touching the runtime, as the runtime status too for a runtime code', async () => {
    const test = recordingRuntime();
    let acquired = 0;
    const runtime: CapabilityRuntime = { ...test.runtime, acquire: async () => { acquired++; return test.runtime.acquire(); } };
    const caps = new MediaCapabilities({ runtime, root, gpuInfo: async () => null, isHardwareEncodeRunning: () => false, override: parseMediaCapsOverride('unavailable:runtime_invalid') });
    expect(await caps.planner()).toEqual({ ok: false, code: 'runtime_invalid' });
    expect(caps.status()).toEqual({ runtime: { state: 'unavailable', code: 'runtime_invalid' }, capabilities: { state: 'unavailable', code: 'runtime_invalid' } });
    expect(acquired).toBe(0);
    expect(test.runs).toEqual([]);

    const notRuntime = new MediaCapabilities({ runtime, root, gpuInfo: async () => null, isHardwareEncodeRunning: () => false, override: parseMediaCapsOverride('unavailable:no_device') });
    expect(await notRuntime.planner()).toEqual({ ok: false, code: 'no_device' });
    expect(notRuntime.status().runtime).toEqual({ state: 'ready', version: 'n8.1.2' });
  });
});
