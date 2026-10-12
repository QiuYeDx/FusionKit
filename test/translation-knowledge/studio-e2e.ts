import { _electron as electron, expect as uiExpect, type ElectronApplication, type Page } from '@playwright/test';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { KnowledgePackage } from '../../src/translation-knowledge/schemas';
import type { LibrarySnapshot } from '../../src/translation-knowledge/ipc-contract';

/** Shared setup for the Studio knowledge UI tests: an isolated profile, a local fake model, a seeded library. */
export type ProviderPayload = {
  items: Array<{ id: string; text: string }>;
  translationRequirements?: string;
  translationKnowledge?: { items: Array<{ kind: string; required?: boolean; applicableItemIds: string[] }> };
};
export type ProviderRequest = { raw: string; payload: ProviderPayload };

/** A loopback chat-completions endpoint. Nothing leaves this machine. An undefined translation drops that item from the reply. */
export async function startProvider(translate: (item: { id: string; text: string }) => string | undefined, hold?: () => Promise<void> | void) {
  const requests: ProviderRequest[] = [], errors: string[] = [];
  const server: Server = createServer(async (request: IncomingMessage, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += String(chunk);
      const body = JSON.parse(raw) as { messages: Array<{ content: string }> };
      const payload = JSON.parse(body.messages[1].content) as ProviderPayload;
      requests.push({ raw, payload });
      await hold?.();
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: payload.items.flatMap(item => { const text = translate(item); return text === undefined ? [] : [{ id: item.id, text }]; }) }) } }],
        usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 } }));
    } catch (error) { errors.push(`Provider fixture: ${String(error)}`); response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { requests, errors, port, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

export const modelPreferences = (port: number, id = 'knowledge-fixture') => JSON.stringify({ version: 5, state: { profiles: [{ id, name: 'Local knowledge fixture', provider: 'DeepSeek', apiKey: 'synthetic-knowledge-key',
  baseUrl: `http://127.0.0.1:${port}`, modelKey: 'deepseek-v4-flash', apiFormat: 'chat_completions', tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 } }],
  assignment: { taskExecution: id, agent: null }, audioProfiles: [], audioAssignment: {} } });

/** Launches the built app with a disposable profile under the OS temp directory. */
export async function launchStudioApp(prefix: string, options: { appRoot?: string; size?: [number, number] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const appRoot = options.appRoot ?? '.';
  // Keeps FUSIONKIT_TEST_WINDOW (quiet by default) and the rest of the environment.
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0] !== 'ELECTRON_RUN_AS_NODE'));
  const app: ElectronApplication = await electron.launch({ args: [appRoot, `--user-data-dir=${path.join(root, 'profile')}`], cwd: options.appRoot ?? process.cwd(),
    env: { ...env, VITE_DEV_SERVER_URL: '', NODE_ENV: 'test' } });
  const ui: Page = await app.firstWindow();
  const errors: string[] = [];
  ui.on('pageerror', error => errors.push(error.message));
  const nativeWindow = await app.browserWindow(ui);
  const [width, height] = options.size ?? [1280, 800];
  await nativeWindow.evaluate((win, size) => { win.webContents.setBackgroundThrottling(false); win.setSize(size[0], size[1]); }, [width, height]);
  return { app, ui, root, errors, profile: path.join(root, 'profile'),
    resize: (w: number, h: number) => nativeWindow.evaluate((win, size) => win.setSize(size[0], size[1]), [w, h]),
    async close() {
      try { const child = app.process(); await app.close(); return child.exitCode !== null || child.signalCode !== null; }
      finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    } };
}

export const settled = (ui: Page) => ui.waitForFunction(() => !document.querySelector('.app-loading-wrap') && !document.querySelector('#app-loading-style'));

/** Language, theme and model are read at startup, so they are written before a reload. */
export async function preparePage(ui: Page, options: { lang: 'zh' | 'en'; theme?: 'light' | 'dark'; port?: number; hash?: string }) {
  await ui.evaluate(({ lang, theme, model, hash }) => {
    localStorage.setItem('translation-knowledge-tour-done', '1');
    localStorage.setItem('subtitle-converter-tour-done', '1');
    localStorage.setItem('lang', lang);
    localStorage.setItem('fusionkit-theme', JSON.stringify({ state: { theme }, version: 0 }));
    if (model) localStorage.setItem('fusionkit-model', model);
    location.hash = hash;
  }, { lang: options.lang, theme: options.theme ?? 'light', model: options.port === undefined ? '' : modelPreferences(options.port), hash: options.hash ?? '/tools/subtitle/studio' });
  await ui.reload(); await settled(ui);
}

/** Writes a package's collections, entries and presets in one transaction through the public bridge. */
export async function seedLibrary(ui: Page, data: Pick<KnowledgePackage, 'collections' | 'entries' | 'presets'>): Promise<LibrarySnapshot> {
  // Passed as text: the package type is too deep for Playwright's argument typing.
  return ui.evaluate(async text => {
    const data = JSON.parse(text) as Pick<KnowledgePackage, 'collections' | 'entries' | 'presets'>;
    const read = await window.translationKnowledge.read(); if (!read.ok) throw new Error(JSON.stringify(read));
    const items = [...data.collections.map(record => ({ group: 'collections' as const, record })), ...data.entries.map(record => ({ group: 'entries' as const, record })),
      ...data.presets.map(record => ({ group: 'presets' as const, record }))];
    let current = read.value;
    for (let index = 0; index < items.length; index += 200) {
      const saved = await window.translationKnowledge.saveRecords({ generation: current.generation, items: items.slice(index, index + 200) });
      if (!saved.ok) throw new Error(JSON.stringify(saved)); current = saved.value;
    }
    return current;
  }, JSON.stringify({ collections: data.collections, entries: data.entries, presets: data.presets }));
}

export const readLibrary = (ui: Page): Promise<LibrarySnapshot> => ui.evaluate(async () => {
  const result = await window.translationKnowledge.read(); if (!result.ok) throw new Error(JSON.stringify(result)); return result.value;
});

/** Opens subtitle files through the Studio button with the native dialog answered in the main process. */
export async function openSubtitles(app: ElectronApplication, ui: Page, files: string[], label: string) {
  await app.evaluate(({ dialog }, filePaths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths }); }, files);
  await ui.getByRole('button', { name: label, exact: true }).first().click();
  if (files.length > 1) {
    await uiExpect(ui.getByTestId('studio-library-result')).toHaveAttribute('data-outcome', 'success');
    await ui.locator('#studio-result-close').click();
  }
}

export const readDocuments = (ui: Page) => ui.evaluate(async () => {
  const listed = await window.subtitleStudio.listDocuments({ offset: 0 }); if (!listed.ok) throw new Error(listed.error);
  return Promise.all(listed.value.documents.map(async document => {
    const result = await window.subtitleStudio.readDocumentPage({ documentId: document.id, revision: document.revision, offset: 0 });
    if (!result.ok) throw new Error(result.error); return result.value;
  }));
});
