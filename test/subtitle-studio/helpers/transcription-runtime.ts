import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { vi } from 'vitest';
import { createRuntimeFixture } from '../transcription/runtimeFixture';
import { createTranscriptionRuntime, type TranscriptionRuntimeDependencies } from '../../../electron/main/subtitle-studio/transcription/runtime';
import { LOCAL_SUBTITLE_MODEL_MANIFEST } from '../../../electron/main/subtitle-studio/transcription/native/model-manifest';
import { createLocalSubtitleServerSession, cleanupLocalSubtitleServerSession } from '../../../electron/main/subtitle-studio/transcription/native/server-session';

// Synthetic child protocol only: no OS process, socket, ASR or external resource is used.
export class SyntheticChild extends EventEmitter {
  static sequence = 84000;
  readonly pid = SyntheticChild.sequence++;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  closed = false;
  closeOnKill = true;
  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.signals.push(signal);
    if (this.closeOnKill) queueMicrotask(() => this.close(signal));
    return true;
  }
  close(signal: NodeJS.Signals | null = null) {
    if (this.closed) return;
    this.closed = true; this.signalCode = signal; this.exitCode = signal ? null : 0;
    this.stdout.end(); this.stderr.end(); this.emit('close', this.exitCode, signal);
  }
}

export async function runtimeFixture(dependencies: TranscriptionRuntimeDependencies = {}) {
  // These tests exercise real filesystem lifecycle rules, so the target must match the host.
  const platform = process.platform === 'win32' ? 'win32' : 'darwin';
  const bundle = await createRuntimeFixture({ mode: 'development', platform, arch: platform === 'win32' ? 'x64' : 'arm64' });
  const userDataRoot = path.join(bundle.tempRoot, 'user-data');
  await mkdir(userDataRoot);
  const bytes = Buffer.alloc(48 + 256, 0x37);
  const original = LOCAL_SUBTITLE_MODEL_MANIFEST.models[0]!;
  Buffer.from(original.ggml.magicHex, 'hex').copy(bytes);
  original.ggml.headerInt32Le.forEach((value, index) => bytes.writeInt32LE(value, 4 + index * 4));
  const model = { ...original, id: 'runtime-test-model', fileName: 'runtime-test-model.bin', byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  const sourcePath = path.join(bundle.tempRoot, 'selected-model.bin');
  await writeFile(sourcePath, bytes);
  const children: SyntheticChild[] = [];
  const sessions: string[] = [];
  const events: string[] = [];
  const controls = { cleanupFailures: 0, holdReadiness: false };
  const readiness = vi.fn(async (signal?: AbortSignal) => {
    if (controls.holdReadiness) await new Promise<void>((_resolve, reject) => {
      if (signal?.aborted) reject(new Error('readiness aborted'));
      else signal?.addEventListener('abort', () => { events.push('readiness-aborted'); reject(new Error('readiness aborted')); }, { once: true });
    });
    return { sessionDisposition: 'reusable' as const };
  });
  const reservePort = vi.fn(async () => ({ port: 44100 + children.length, release: async () => { events.push('port-released'); } }));
  const spawnProcess = vi.fn((_command: string, _args: readonly string[]) => {
    const child = new SyntheticChild(); children.push(child); events.push('spawn');
    child.on('close', () => events.push('child-closed'));
    return child as unknown as ChildProcess;
  });
  const mediaRunner = vi.fn(async () => { throw new Error('Unexpected media process request.'); });
  const downloadResource = vi.fn(async () => { throw new Error('Unexpected network download.'); });
  const adapters: TranscriptionRuntimeDependencies = {
    signatureVerifier: async () => true,
    media: { processRunner: mediaRunner },
    resources: { modelCatalog: [model], availableBytes: async () => Number.MAX_SAFE_INTEGER, downloadResource },
    server: { startupTimeoutMs: 500, startupPollIntervalMs: 1, idleTimeoutMs: 60_000,
      abortGraceMs: 5, terminateGraceMs: 5, forceKillGraceMs: 5, maxStartAttempts: 1,
      dependencies: { reservePort, spawnProcess,
        createHttpClient: () => ({ sessionDisposition: 'reusable', probeReadiness: readiness,
          health: async () => ({ sessionDisposition: 'reusable' }), inference: async () => { throw new Error('Unexpected ASR inference.'); } }),
        createSession: async root => { const session = await createLocalSubtitleServerSession(root); sessions.push(session.root); return session; },
        cleanupSession: async session => {
          events.push('cleanup-session');
          if (controls.cleanupFailures > 0) { controls.cleanupFailures--; throw new Error('Injected session cleanup failure.'); }
          return cleanupLocalSubtitleServerSession(session);
        },
      },
    },
  };
  const effective = { ...adapters, ...dependencies,
    resources: { ...adapters.resources, ...dependencies.resources },
    media: { ...adapters.media, ...dependencies.media },
    server: { ...adapters.server, ...dependencies.server,
      dependencies: { ...adapters.server?.dependencies, ...dependencies.server?.dependencies } },
  };
  const runtime = createTranscriptionRuntime({ userDataRoot, environment: bundle.environment }, effective);
  return { bundle, runtime, userDataRoot, model, sourcePath, bytes, children, sessions, events, controls, adapters: effective,
    spawnProcess, reservePort, readiness, mediaRunner, downloadResource,
    async cleanup() {
      for (const child of children) child.close();
      controls.cleanupFailures = 0;
      const failures: unknown[] = [];
      try { await runtime.shutdown('fatal'); } catch (error) { failures.push(error); }
      try { await bundle.cleanup(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'Runtime test cleanup failed.');
    },
  };
}

export async function eventually(predicate: () => boolean) {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Expected lifecycle condition did not occur.');
}
