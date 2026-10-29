import { engineReasonCodeSchema, type EngineReasonCode } from '../../../src/media-converter/contract';

/**
 * Test switches of the media converter (module-engine design §9). They count only in a test build:
 * NODE_ENV=test in an unpackaged run, the gate of every FUSIONKIT_TEST_* switch
 * (`createTestSystemSetup` in system/index.ts). An installed build never honours them, whatever its
 * environment says. Values that do not parse are ignored as if unset.
 */

/**
 * Replaces the encoder detection (R-ENGINE-03), which then never runs a test encode nor reads or
 * writes `capabilities.json`; the bundled runtime is still verified as usual.
 * - `cpu_only`: no hardware encoder works, so every codec falls to the CPU encoders;
 * - `nvenc`: exactly the NVENC configurations work (h264, hevc 8/10-bit with uhq and hq, av1 with uhq and hq);
 * - `unavailable:<code>`: detection fails with that engine reason code; a runtime code (`runtime_invalid`) is the runtime's status as well;
 * - `detecting_ms:<n>`: detection takes n milliseconds (at most 10 minutes), then ends as `cpu_only`.
 */
export const TEST_MEDIA_CAPS_ENV = 'FUSIONKIT_TEST_MEDIA_CAPS';

/**
 * `<code>:first_attempt`: the first ffmpeg run of every item fails with that code before its first
 * frame, without starting ffmpeg, and carries a made-up stderr tail of that failure (the lines the
 * real failure prints, with no path in them). The executor then handles it as it would the real
 * one: a hardware encoder's failure falls back to the next encoder once (AC-ENGINE-03-3), a full
 * disk fails the item `disk_full`. Later runs of the item (the fallback, a retry) run for real.
 */
export const TEST_MEDIA_FAIL_ENV = 'FUSIONKIT_TEST_MEDIA_FAIL';

/** `record`: "show in folder" records the call instead of opening Explorer. */
export const TEST_MEDIA_REVEAL_ENV = 'FUSIONKIT_TEST_MEDIA_REVEAL';

export type MediaCapsOverride =
  | { readonly kind: 'cpu_only' }
  | { readonly kind: 'nvenc' }
  | { readonly kind: 'unavailable'; readonly code: EngineReasonCode }
  | { readonly kind: 'detecting'; readonly milliseconds: number };

/**
 * The failures `FUSIONKIT_TEST_MEDIA_FAIL` can inject: what one ffmpeg run can end with. The
 * hardware categories of design §3 (an encoder that cannot open), the process's own codes (a
 * stall, a full disk, an output that cannot be opened), and `encode_failed`, a failure that names
 * no reason.
 */
export const MEDIA_FAIL_CODES = [
  'driver_too_old', 'no_device', 'session_limit', 'params_rejected', 'unknown', 'encoder_stalled', 'disk_full', 'output_open_failed', 'encode_failed',
] as const satisfies readonly EngineReasonCode[];
export type MediaFailCode = (typeof MEDIA_FAIL_CODES)[number];

export interface MediaFailInjection {
  readonly code: MediaFailCode;
  /** The only form of design §9: the first run of each item. */
  readonly when: 'first_attempt';
}

export type MediaRevealOverride = 'record';

export interface MediaTestHooks {
  readonly caps: MediaCapsOverride | null;
  readonly fail: MediaFailInjection | null;
  readonly reveal: MediaRevealOverride | null;
}

export const MEDIA_TEST_HOOK_LIMITS = Object.freeze({
  /** `detecting_ms` beyond this is refused: a test waits seconds, never long enough to look hung. */
  maxDetectingMs: 600_000,
});

const NO_HOOKS: MediaTestHooks = Object.freeze({ caps: null, fail: null, reveal: null });
const FAIL_CODES: ReadonlySet<string> = new Set(MEDIA_FAIL_CODES);

/** The variables read here; `process.env` is one (a plain record, so a test need not build a whole `ProcessEnv`). */
export type MediaTestEnvironment = Readonly<Record<string, string | undefined>>;

/** A test build: NODE_ENV=test and not packaged. */
export const isMediaTestBuild = (env: MediaTestEnvironment, options: { readonly packaged: boolean }) => env.NODE_ENV === 'test' && !options.packaged;

/** `FUSIONKIT_TEST_MEDIA_CAPS` as written, or null when it is unset or malformed. */
export function parseMediaCapsOverride(value: string | undefined): MediaCapsOverride | null {
  const text = value?.trim();
  if (!text) return null;
  if (text === 'cpu_only' || text === 'nvenc') return Object.freeze({ kind: text });
  const unavailable = /^unavailable:([a-z][a-z0-9_]{0,63})$/.exec(text);
  if (unavailable) {
    const code = engineReasonCodeSchema.safeParse(unavailable[1]);
    return code.success ? Object.freeze({ kind: 'unavailable', code: code.data }) : null;
  }
  const detecting = /^detecting_ms:(\d{1,9})$/.exec(text);
  if (detecting) {
    const milliseconds = Number(detecting[1]);
    return milliseconds <= MEDIA_TEST_HOOK_LIMITS.maxDetectingMs ? Object.freeze({ kind: 'detecting', milliseconds }) : null;
  }
  return null;
}

/** `FUSIONKIT_TEST_MEDIA_FAIL` as written (`no_device:first_attempt`), or null when it is unset, malformed or names another code. */
export function parseMediaFailInjection(value: string | undefined): MediaFailInjection | null {
  const match = /^([a-z][a-z0-9_]{0,63}):first_attempt$/.exec(value?.trim() ?? '');
  return match && FAIL_CODES.has(match[1]) ? Object.freeze({ code: match[1] as MediaFailCode, when: 'first_attempt' }) : null;
}

/** `FUSIONKIT_TEST_MEDIA_REVEAL` as written, or null. */
export function parseMediaRevealOverride(value: string | undefined): MediaRevealOverride | null {
  return value?.trim() === 'record' ? 'record' : null;
}

/** The switches this run honours: none at all outside a test build. */
export function resolveMediaTestHooks(env: MediaTestEnvironment, options: { readonly packaged: boolean }): MediaTestHooks {
  if (!isMediaTestBuild(env, options)) return NO_HOOKS;
  return Object.freeze({
    caps: parseMediaCapsOverride(env[TEST_MEDIA_CAPS_ENV]),
    fail: parseMediaFailInjection(env[TEST_MEDIA_FAIL_ENV]),
    reveal: parseMediaRevealOverride(env[TEST_MEDIA_REVEAL_ENV]),
  });
}
