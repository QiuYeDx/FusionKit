import { mkdtemp, realpath, rm, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupSpeechResourceSessionStartupOrphans } from '../../../electron/main/speech-resources/engine/resource-startup-cleaner';
import { createLocalSubtitleServerSession, cleanupLocalSubtitleServerSession } from '../../../electron/main/subtitle-studio/transcription/native/server-session';
import { createSpeechResourceSmoke } from '../../../electron/main/subtitle-studio/transcription/shared-resources';
import type { LocalSubtitleServerSupervisorOptions } from '../../../electron/main/subtitle-studio/transcription/native/server-supervisor';

const controls = vi.hoisted(() => ({ construct: vi.fn(), shutdown: vi.fn(async (_reason: unknown) => undefined) }));
// Capture the actual production callback without launching any native process.
vi.mock('../../../electron/main/subtitle-studio/transcription/native/server-supervisor', () => ({
  LocalSubtitleServerSupervisor: class {
    constructor(options: unknown) { controls.construct(options); }
    snapshot = { state: 'disposed' };
    shutdown(reason: unknown) { return controls.shutdown(reason); }
  },
}));
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); controls.construct.mockClear(); controls.shutdown.mockClear(); });
async function root() { const value = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sr-smoke-'))); roots.push(value); return value; }
function callback() { return (controls.construct.mock.calls.at(-1)![0] as LocalSubtitleServerSupervisorOptions).dependencies!.createSession!; }

describe('dedicated resource smoke startup cleanup', () => {
  it('lazily joins one orphan sweep before creating sessions and never sweeps a live session again', async () => {
    const directory = await root(), sessionRoot = path.join(directory, 'smoke'), old = await createLocalSubtitleServerSession(sessionRoot);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const cleanup = vi.fn(async (options: Parameters<typeof cleanupSpeechResourceSessionStartupOrphans>[0]) => { await gate; return cleanupSpeechResourceSessionStartupOrphans(options); });
    const smoke = createSpeechResourceSmoke({ managedResourceRoot: path.join(directory, 'shared'), sessionRoot,
      environment: { mode: 'development', appRoot: directory } }, { startupCleanup: cleanup });
    expect(cleanup).not.toHaveBeenCalled();
    const first = callback()(path.join(directory, 'shared')), second = callback()(path.join(directory, 'shared'));
    await Promise.resolve(); expect(cleanup).toHaveBeenCalledOnce(); release();
    const sessions = await Promise.all([first, second]);
    await expect(lstat(old.root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(sessions[0].root).not.toBe(sessions[1].root); await expect(lstat(sessions[0].root)).resolves.toBeDefined();
    expect(cleanup).toHaveBeenCalledOnce();
    await Promise.all(sessions.map(cleanupLocalSubtitleServerSession)); await smoke.shutdown('app_quit');
  });
  it('fences new sessions synchronously and retains the shutdown join while startup cleanup is pending', async () => {
    const directory = await root(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const smoke = createSpeechResourceSmoke({ managedResourceRoot: path.join(directory, 'shared'), sessionRoot: path.join(directory, 'smoke'),
      environment: { mode: 'development', appRoot: directory } }, { startupCleanup: async options => { await gate; return cleanupSpeechResourceSessionStartupOrphans(options); } });
    const creating = callback()(path.join(directory, 'shared')); const rejected = expect(creating).rejects.toMatchObject({ code: 'owner_released' });
    let joined = false; const closing = smoke.shutdown('app_quit'); void closing.then(() => { joined = true; });
    expect(smoke.shutdown('app_quit')).toBe(closing); expect(controls.shutdown).toHaveBeenCalledOnce();
    await Promise.resolve(); await Promise.resolve(); expect(joined).toBe(false);
    await expect(callback()(path.join(directory, 'shared'))).rejects.toMatchObject({ code: 'owner_released' });
    release(); await closing; await rejected; expect(joined).toBe(true);
  });
});
