import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createRuntimeFixture } from '../../subtitle-studio/transcription/runtimeFixture';
import { createSpeechResourceSmoke } from '../../../electron/main/subtitle-studio/transcription/shared-resources';
import { LOCAL_SUBTITLE_PRODUCTION_CONTRACT } from '../../../src/subtitle-studio/transcription/domain';
import type { LocalSubtitleOwnerKey } from '../../../electron/main/subtitle-studio/transcription/native/authorizations';
import type { LocalSubtitleServerSupervisor, LocalSubtitleServerSupervisorLoadOptions, LocalSubtitleServerSupervisorOptions } from '../../../electron/main/subtitle-studio/transcription/native/server-supervisor';

const observations = vi.hoisted(() => ({ owners: [] as LocalSubtitleOwnerKey[], supervisors: [] as LocalSubtitleServerSupervisor[],
  children: [] as { closed: boolean }[], sessionRoots: [] as string[] }));

// Only OS process/socket/HTTP and the signature probe are synthetic. The actual
// supervisor, owner admission, proof branding and session filesystem checks run.
vi.mock('../../../electron/main/subtitle-studio/transcription/native/resource-path', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../electron/main/subtitle-studio/transcription/native/resource-path')>();
  return { ...actual, verifyLocalSubtitleRuntimeBundle: (options: Parameters<typeof actual.verifyLocalSubtitleRuntimeBundle>[0]) =>
    actual.verifyLocalSubtitleRuntimeBundle({ ...options, signatureVerifier: async () => true }) };
});
vi.mock('../../../electron/main/subtitle-studio/transcription/native/server-supervisor', async importOriginal => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const actual = await importOriginal<typeof import('../../../electron/main/subtitle-studio/transcription/native/server-supervisor')>();
  return { ...actual, LocalSubtitleServerSupervisor: class extends actual.LocalSubtitleServerSupervisor {
    constructor(options: LocalSubtitleServerSupervisorOptions) {
      super({ ...options, startupTimeoutMs: 500, startupPollIntervalMs: 1, maxStartAttempts: 1,
        abortGraceMs: 5, terminateGraceMs: 5, forceKillGraceMs: 5, idleTimeoutMs: 60000,
        dependencies: { ...options.dependencies,
          createSession: async root => {
            const session = await options.dependencies!.createSession!(root); observations.sessionRoots.push(session.root); return session;
          },
          reservePort: async () => ({ port: 44999, release: async () => undefined }),
          spawnProcess: () => {
            class Child extends EventEmitter {
              readonly pid = 84000 + observations.children.length;
              readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
              exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; closed = false;
              kill(signal: NodeJS.Signals = 'SIGTERM') {
                queueMicrotask(() => { if (this.closed) return; this.closed = true; this.signalCode = signal;
                  this.stdout.end(); this.stderr.end(); this.emit('close', null, signal); }); return true;
              }
            }
            const child = new Child(); observations.children.push(child); return child as unknown as import('node:child_process').ChildProcess;
          },
          createHttpClient: () => ({ sessionDisposition: 'reusable', probeReadiness: async () => ({ sessionDisposition: 'reusable' }),
            health: async () => ({ sessionDisposition: 'reusable' }), inference: async () => { throw new Error('No inference in admission regression.'); } }),
        } });
      observations.supervisors.push(this);
    }
    acquire(owner: LocalSubtitleOwnerKey, options: LocalSubtitleServerSupervisorLoadOptions, signal?: AbortSignal) {
      observations.owners.push(owner); return super.acquire(owner, options, signal);
    }
  } };
});

const fixtures: Awaited<ReturnType<typeof createRuntimeFixture>>[] = [];
const smokes: ReturnType<typeof createSpeechResourceSmoke>[] = [];
afterEach(async () => {
  try { await Promise.all(smokes.splice(0).map(smoke => smoke.shutdown('fatal'))); }
  finally { await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()));
    observations.owners.length = observations.supervisors.length = observations.children.length = observations.sessionRoots.length = 0; }
});

async function setup() {
  const platform = process.platform === 'win32' ? 'win32' : 'darwin';
  const fixture = await createRuntimeFixture({ platform, arch: platform === 'win32' ? 'x64' : 'arm64' }); fixtures.push(fixture);
  const root = await realpath(fixture.tempRoot), managedResourceRoot = path.join(root, 'speech-resources');
  const smoke = createSpeechResourceSmoke({ managedResourceRoot, sessionRoot: path.join(root, 'smoke'), environment: fixture.environment }); smokes.push(smoke);
  const model = { storage: 'managed_staging' as const, id: 'model', absolutePath: path.join(managedResourceRoot, 'model-staging', 'model.bin'), byteSize: 100, sha256: 'a'.repeat(64) };
  const input = { owner: { webContentsId: 0, ownerSessionId: 'application-resource-owner' }, model, signal: new AbortController().signal };
  return { smoke, input, managedResourceRoot };
}

describe('application resource owner to native smoke owner admission', () => {
  it('admits owner zero through private model and VAD smoke ownership and joins cleanup', async () => {
    const { smoke, input, managedResourceRoot } = await setup();
    await expect(smoke.smokeModel(input)).resolves.toBeUndefined();
    await expect(smoke.smokeVad({ ...input, model: { ...input.model, storage: 'managed' }, vad: {
      storage: 'managed_staging', id: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.id,
      absolutePath: path.join(managedResourceRoot, 'vad-staging', 'vad.bin'), byteSize: 100, sha256: LOCAL_SUBTITLE_PRODUCTION_CONTRACT.vad.sha256,
    } })).resolves.toBeUndefined();
    expect(observations.owners).toHaveLength(2);
    expect(observations.owners[0]).toEqual(observations.owners[1]);
    expect(observations.owners[0]!.webContentsId).toBeGreaterThan(0);
    expect(observations.owners[0]!.ownerSessionId).not.toBe(input.owner.ownerSessionId);
    expect(input.owner.webContentsId).toBe(0);
    expect(observations.children.length).toBe(2);
    await smoke.shutdown('app_quit');
    expect(observations.children.every(child => child.closed)).toBe(true);
    expect(smoke.snapshot().state).toBe('disposed');
    for (const root of observations.sessionRoots) await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(smoke.smokeModel(input)).rejects.toMatchObject({ code: 'owner_released' });
  });

  it('retains the real supervisor zero-owner rejection and isolates each smoke factory', async () => {
    const first = await setup(), second = await setup();
    await expect(observations.supervisors[0]!.acquire(first.input.owner, {} as never)).rejects.toMatchObject({
      localSubtitleCode: 'runtime_protocol_mismatch', message: 'The local inference owner is invalid.',
    });
    observations.owners.length = 0;
    await first.smoke.smokeModel(first.input); await second.smoke.smokeModel(second.input);
    expect(observations.owners[0]!.ownerSessionId).not.toBe(observations.owners[1]!.ownerSessionId);
  });
});
