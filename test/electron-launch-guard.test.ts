import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { guardElectronLaunch, LAUNCH_GUARD, missingAppEntry, REPORT_LOG_ENV, takeErrorBoxReports } from '../scripts/guard-electron-launch.mjs';
import { acquireTestBuildLock, holdTestBuildLock, joinUiTestRun, leaveUiTestRun, liveTestBuild, liveUiTestRuns } from '../scripts/ui-test-lock.mjs';
import { createTestRun } from './support/testRun';

const artifacts = path.resolve('test-results/electron-launch-guard');
const PLAYWRIGHT_ARGS = ['-r', 'C:/playwright/loader.js', '--inspect=0', '--remote-debugging-port=0'];

/** A checkout-like folder whose package.json names the real main entry, built or not. */
async function checkout(built: boolean) {
  const root = path.join(await createTestRun(artifacts), 'checkout');
  await mkdir(path.join(root, 'dist-electron/main'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ main: 'dist-electron/main/index.js' }));
  if (built) await writeFile(path.join(root, 'dist-electron/main/index.js'), '');
  return root;
}

const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid as number;
const owner = (pid: number, extra: object = {}) => JSON.stringify({ pid, ...extra });
const later = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const sixMinutesAgo = () => new Date(Date.now() - 6 * 60 * 1000);

describe('missingAppEntry', () => {
  it('reads the app argument the way Electrons default app does', async () => {
    const empty = await checkout(false);
    const argv = [...PLAYWRIGHT_ARGS, '-r', LAUNCH_GUARD, '.', '--user-data-dir=C:/profile'];
    expect(missingAppEntry(argv, empty)).toBe(`The Electron app entry ${path.join(empty, 'dist-electron/main/index.js')} does not exist.`);
    expect(missingAppEntry([`--app=${empty}`], 'C:/elsewhere')).toMatch(/does not exist/);
    expect(missingAppEntry([...PLAYWRIGHT_ARGS, empty], 'C:/elsewhere')).toMatch(/does not exist/);
    expect(missingAppEntry(['.'], path.join(empty, 'not-a-checkout'))).toMatch(/does not exist/);

    const built = await checkout(true);
    expect(missingAppEntry(argv, built)).toBeNull();
    expect(missingAppEntry(['dist-electron/main/index'], built)).toBeNull();
    // Nothing to check: no app argument, or Electron only prints its version.
    expect(missingAppEntry(['-r', 'x.js', '--inspect=0'], empty)).toBeNull();
    expect(missingAppEntry(['--version', '.'], empty)).toBeNull();
  });
});

describe('guardElectronLaunch', () => {
  function launcher(stderr?: PassThrough) {
    const child = Object.assign(new EventEmitter(), { stderr });
    const launch = vi.fn(async (options?: Record<string, unknown>) => ({ options, process: () => child }));
    return { electron: { launch } as { launch(options?: Record<string, unknown>): Promise<unknown> }, launch, child };
  }

  it('never starts Electron while the build output is missing', async () => {
    const empty = await checkout(false);
    const { electron, launch } = launcher();
    const join = vi.fn(async () => {});
    guardElectronLaunch(electron, { join });
    await expect(electron.launch({ args: ['.'], cwd: empty })).rejects.toThrow(/does not exist\. Build the test bundle first: pnpm run pretest/);
    expect(join).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
  });

  it('registers first, then loads the guard ahead of the app, once however often it is guarded', async () => {
    const built = await checkout(true);
    const { electron, launch } = launcher();
    const order: string[] = [];
    launch.mockImplementation(async options => (order.push('launch'), { options, process: () => new EventEmitter() }));
    const join = async () => { order.push('join'); };
    guardElectronLaunch(electron, { join });
    guardElectronLaunch(electron, { join });
    await electron.launch({ args: ['.', '--user-data-dir=C:/profile'], cwd: built, env: { NODE_ENV: 'test' } });
    expect(order).toEqual(['join', 'launch']);
    expect(launch).toHaveBeenCalledWith({ args: ['-r', LAUNCH_GUARD, '.', '--user-data-dir=C:/profile'], cwd: built, env: { NODE_ENV: 'test', [REPORT_LOG_ENV]: expect.stringMatching(/fusionkit-error-boxes-.+\.log$/) } });
  });

  it('leaves packaged executables alone: they never read -r or dist-electron/', async () => {
    const { electron, launch } = launcher();
    const join = vi.fn(async () => {});
    guardElectronLaunch(electron, { join });
    await electron.launch({ executablePath: 'C:/FusionKit/FusionKit.exe', args: ['--user-data-dir=C:/profile'] });
    expect(launch).toHaveBeenCalledWith({ executablePath: 'C:/FusionKit/FusionKit.exe', args: ['--user-data-dir=C:/profile'] });
    expect(join).not.toHaveBeenCalled();
  });

  it('echoes error-box reports from stderr and collects them from the report file, early ones included', async () => {
    const built = await checkout(true);
    const stderr = new PassThrough();
    const { electron, launch, child } = launcher(stderr);
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    guardElectronLaunch(electron, { join: async () => {} });
    await electron.launch({ args: ['.'], cwd: built });
    const report = (launch.mock.calls[0][0] as { env: Record<string, string> }).env[REPORT_LOG_ENV];
    // What the guard inside Electron writes, starting before launch() has resolved.
    const lines = ['[electron-launch-guard] A JavaScript error occurred in the main process', '[electron-launch-guard] Uncaught Exception:'];
    await appendFile(report, `${lines[0]}\n`);
    stderr.write(`${lines[1]}\nother output\n`);
    await appendFile(report, `${lines[1]}\n[electron-launch-guard] half a li`);
    await later(20);
    expect(takeErrorBoxReports()).toEqual(lines);
    expect(takeErrorBoxReports()).toEqual([]);
    expect(printed.mock.calls.map(call => call[0])).toEqual([lines[1]]);
    printed.mockRestore();
    // Once the app has exited and its last reports are read, the report file goes.
    await appendFile(report, 'lf\n[electron-launch-guard] at exit\n');
    child.emit('exit', 0);
    expect(takeErrorBoxReports()).toEqual(['[electron-launch-guard] half a lilf', '[electron-launch-guard] at exit']);
    expect(existsSync(report)).toBe(false);
    expect(takeErrorBoxReports()).toEqual([]);
  });
});

describe('ui-test-lock', () => {
  const lockDir = async () => {
    const dir = path.join(await createTestRun(artifacts), 'locks');
    await mkdir(path.join(dir, 'runs'), { recursive: true });
    return dir;
  };
  const markers = async (dir: string) => (await readdir(path.join(dir, 'runs'))).filter(name => name.endsWith('.json'));

  it('makes a test file wait for a running build, then registers it until it leaves', async () => {
    const dir = await lockDir();
    await writeFile(path.join(dir, 'build.json'), owner(process.pid));
    const log = vi.fn();
    let joined = false;
    const first = joinUiTestRun({ dir, pollMs: 10, log }).then(() => { joined = true; });
    const second = joinUiTestRun({ dir, pollMs: 10, log: () => {} });
    await later(120);
    expect(joined).toBe(false);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toMatch(`Waiting for a build (pid ${process.pid}) to finish`);
    expect(liveUiTestRuns(dir)).toEqual([]);

    await rm(path.join(dir, 'build.json'));
    await Promise.all([first, second]);
    expect(liveUiTestRuns(dir).map(run => run.pid)).toEqual([process.pid]);
    expect(await markers(dir)).toHaveLength(1);
    // Registered processes go ahead without waiting, even while a build waits for them.
    await writeFile(path.join(dir, 'build.json'), owner(process.pid));
    await joinUiTestRun({ dir, timeoutMs: 0 });
    // Once the file is done, the build goes first.
    leaveUiTestRun({ dir });
    expect(await markers(dir)).toEqual([]);
    await expect(joinUiTestRun({ dir, timeoutMs: 30, pollMs: 10, log: () => {} })).rejects.toThrow(`A build (pid ${process.pid}) is still rewriting dist/ and dist-electron/.`);
    expect(await markers(dir)).toEqual([]);
    // A build that is only waiting for other test files is named as such, not as one to delete.
    const other = path.join(dir, 'runs', 'other.json');
    await writeFile(other, owner(process.pid));
    await expect(joinUiTestRun({ dir, timeoutMs: 30, pollMs: 10, log: () => {} })).rejects.toThrow(`is waiting for other Electron UI tests to finish (${other})`);
  });

  it('lets a test file through a stale build lock without removing it', async () => {
    const dir = await lockDir();
    await writeFile(path.join(dir, 'build.json'), owner(deadPid()));
    await joinUiTestRun({ dir, timeoutMs: 0 });
    expect(existsSync(path.join(dir, 'build.json'))).toBe(true);
    leaveUiTestRun({ dir });
  });

  it('makes a build wait for running Electron tests and for another build, and releases only its own lock', async () => {
    const dir = await lockDir();
    const marker = path.join(dir, 'runs', 'other.json');
    await writeFile(marker, owner(process.pid));
    await expect(acquireTestBuildLock({ dir, timeoutMs: 50, pollMs: 10 })).rejects.toThrow(`If none is running, delete ${marker}.`);
    expect(liveTestBuild(dir)).toBeUndefined();

    const log = vi.fn();
    const pending = acquireTestBuildLock({ dir, pollMs: 10, log });
    await later(80);
    expect(log).toHaveBeenCalledWith(`Waiting for running Electron UI tests to finish before rebuilding (${marker})...`);
    await rm(marker);
    const release = await pending;
    expect(liveTestBuild(dir)?.pid).toBe(process.pid);

    let second = false;
    const next = acquireTestBuildLock({ dir, pollMs: 10 }).then(releaseNext => { second = true; return releaseNext; });
    await later(80);
    expect(second).toBe(false);
    release();
    (await next)();
    expect(liveTestBuild(dir)).toBeUndefined();

    // Releasing does not remove a lock someone else holds now.
    await writeFile(path.join(dir, 'build.json'), owner(process.ppid, { token: 'someone else' }));
    release();
    expect(JSON.parse(await readFile(path.join(dir, 'build.json'), 'utf8')).pid).toBe(process.ppid);
  });

  it('removes files of processes that are gone or never finished writing them', async () => {
    const dir = await lockDir();
    const runs = path.join(dir, 'runs');
    await writeFile(path.join(dir, 'build.json'), owner(deadPid()));
    await writeFile(path.join(dir, 'build.json.reap'), owner(deadPid()));
    await writeFile(path.join(runs, 'dead.json'), owner(deadPid()));
    // A torn file just written may be an exclusive create still being filled in; an old one is garbage.
    await writeFile(path.join(runs, 'torn.json'), '{"pid":');
    await utimes(path.join(runs, 'torn.json'), sixMinutesAgo(), sixMinutesAgo());

    const release = await acquireTestBuildLock({ dir, timeoutMs: 1000, pollMs: 10 });
    expect(liveTestBuild(dir)?.pid).toBe(process.pid);
    expect(await markers(dir)).toEqual([]);
    expect(existsSync(path.join(dir, 'build.json.reap'))).toBe(false);
    release();
    expect(existsSync(path.join(dir, 'build.json'))).toBe(false);
  });

  it('reaps the untouched file of a live pid only after watching it for two heartbeats, so owners survive a machine waking up', async () => {
    const dir = await lockDir();
    const quiet = path.join(dir, 'runs', 'quiet.json');
    const old = sixMinutesAgo();
    await writeFile(quiet, owner(process.pid));
    await utimes(quiet, old, old);
    let clock = 0;
    const monotonic = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    try {
      expect(liveUiTestRuns(dir)).toHaveLength(1);
      clock += 9_000;
      expect(liveUiTestRuns(dir)).toHaveLength(1);
      // Its owner's heartbeat comes: no longer suspect.
      await utimes(quiet, new Date(), new Date());
      clock += 9_000;
      expect(liveUiTestRuns(dir)).toHaveLength(1);
      await utimes(quiet, old, old);
      for (let look = 0; look < 3; look++) {
        clock += 9_000;
        expect(liveUiTestRuns(dir)).toHaveLength(1);
      }
      clock += 9_000;
      expect(liveUiTestRuns(dir)).toEqual([]);
      expect(existsSync(quiet)).toBe(false);
    } finally {
      monotonic.mockRestore();
    }
  });

  it('does not rebuild when its lock was deleted or taken over while it waited', async () => {
    const dir = await lockDir();
    const marker = path.join(dir, 'runs', 'other.json');
    await writeFile(marker, owner(process.pid));
    const pending = acquireTestBuildLock({ dir, pollMs: 10 });
    await later(50);
    await rm(path.join(dir, 'build.json'));
    await rm(marker);
    await expect(pending).rejects.toThrow(`${path.join(dir, 'build.json')} was deleted or taken over while this build waited`);
  });

  it('removes its own build lock when the build process exits, but not one another build took over', async () => {
    const dir = await lockDir();
    const lock = path.join(dir, 'build.json');
    const build = (then: string) => spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { writeFileSync } from 'node:fs';
      import { holdTestBuildLock } from ${JSON.stringify(pathToFileURL(path.resolve('scripts/ui-test-lock.mjs')).href)};
      await holdTestBuildLock({ dir: ${JSON.stringify(dir)} });
      ${then}
    `], { encoding: 'utf8' });
    expect(build(`writeFileSync(${JSON.stringify(lock)}, JSON.stringify({ pid: ${process.pid}, token: 'next build' }));`).status).toBe(0);
    expect(JSON.parse(await readFile(lock, 'utf8')).token).toBe('next build');
    await rm(lock);
    expect(build('').status).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it('holds the lock of a build process once, however often the build config asks', async () => {
    const dir = await lockDir();
    await Promise.all([holdTestBuildLock({ dir }), holdTestBuildLock({ dir })]);
    expect(liveTestBuild(dir)?.pid).toBe(process.pid);
    await holdTestBuildLock({ dir, timeoutMs: 0 });
  });
});
