import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeLegacyTextTranslationWorkspace } from '../../electron/main/long-text/legacy-cleanup';

let userData: string;
let outside: string;
let workspace: string;

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'long-text-legacy-'));
  userData = path.join(root, 'userData');
  outside = path.join(root, 'outside');
  workspace = path.join(userData, 'text-translation');
  await fs.mkdir(userData);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'not ours');
});

afterEach(async () => {
  await fs.rm(path.dirname(userData), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const exists = (target: string) => fs.lstat(target).then(() => true, () => false);

/** The old tool's layout: one folder per task with its workspace files. */
async function oldTasks(): Promise<void> {
  const task = path.join(workspace, 'tasks', '6f1c2b8e-1111-4c4c-8d8d-123456789abc');
  await fs.mkdir(path.join(task, 'output'), { recursive: true });
  await fs.writeFile(path.join(task, 'task.json'), '{}');
  await fs.writeFile(path.join(task, 'events.jsonl'), '{}\n');
}

describe('removeLegacyTextTranslationWorkspace (AC-LT-01-4)', () => {
  it('removes a workspace that holds only tasks', async () => {
    await oldTasks();
    expect(await removeLegacyTextTranslationWorkspace(userData)).toBe('removed');
    expect(await exists(workspace)).toBe(false);
  });

  it('also removes it when Finder left a .DS_Store next to tasks', async () => {
    await oldTasks();
    await fs.writeFile(path.join(workspace, '.DS_Store'), '');
    expect(await removeLegacyTextTranslationWorkspace(userData)).toBe('removed');
    expect(await exists(workspace)).toBe(false);
  });

  it('never follows a junction inside tasks while removing', async () => {
    await oldTasks();
    await fs.symlink(outside, path.join(workspace, 'tasks', 'linked'), 'junction');
    expect(await removeLegacyTextTranslationWorkspace(userData)).toBe('removed');
    expect(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('not ours');
  });

  it('keeps a workspace with any other entry', async () => {
    await oldTasks();
    await fs.writeFile(path.join(workspace, 'notes.txt'), 'mine');
    expect(await removeLegacyTextTranslationWorkspace(userData)).toBe('kept');
    expect(await fs.readFile(path.join(workspace, 'notes.txt'), 'utf8')).toBe('mine');
    expect(await exists(path.join(workspace, 'tasks'))).toBe(true);
  });

  it('keeps a workspace that is a junction, and what it points to', async () => {
    await fs.mkdir(path.join(outside, 'tasks'));
    await fs.symlink(outside, workspace, 'junction');
    await fs.rm(path.join(outside, 'keep.txt'));
    expect(await removeLegacyTextTranslationWorkspace(userData)).toBe('kept');
    expect((await fs.lstat(workspace)).isSymbolicLink()).toBe(true);
    expect(await exists(path.join(outside, 'tasks'))).toBe(true);
  });

  it('keeps a workspace whose tasks entry is a junction', async () => {
    await fs.mkdir(workspace);
    await fs.symlink(outside, path.join(workspace, 'tasks'), 'junction');
    expect(await removeLegacyTextTranslationWorkspace(userData)).toBe('kept');
    expect(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('not ours');
  });

  it('keeps a file of that name', async () => {
    await fs.writeFile(workspace, 'a file');
    expect(await removeLegacyTextTranslationWorkspace(userData)).toBe('kept');
    expect(await fs.readFile(workspace, 'utf8')).toBe('a file');
  });

  it('reports a missing workspace as absent', async () => {
    expect(await removeLegacyTextTranslationWorkspace(userData)).toBe('absent');
    expect(await exists(workspace)).toBe(false);
  });
});
