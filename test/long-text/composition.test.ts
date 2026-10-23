import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

/** FK-PIT-0079: an exposed preload API needs its handlers in the production main-process composition. */
describe('long text composition (AC-LT-20-3)', () => {
  it('registers the long text module in the main process before the first window', () => {
    const main = read('electron/main/index.ts');
    expect(main).toContain('import { registerLongText } from "./long-text";');
    const registration = main.indexOf('registerLongText(');
    expect(registration).toBeGreaterThan(main.indexOf('translationKnowledge = registerTranslationKnowledge();'));
    expect(main.indexOf('  createWindow();')).toBeGreaterThan(registration);
    expect(main).not.toContain('text-translation');
  });

  it('exposes window.longText and guards its channels on the legacy bridge', () => {
    const preload = read('electron/preload/index.ts');
    expect(preload).toContain("exposeInMainWorld('longText', createLongTextApi(ipcRenderer))");
    // Once among the command guards and once among the listen guards.
    expect(preload.match(/^ {2}assertLegacyLongTextChannelAllowed\(channel\)$/gm)).toHaveLength(2);
    expect(preload).not.toContain('text-translation');
  });

  it('declares window.longText for the renderer', () => {
    expect(read('src/vite-env.d.ts')).toContain("longText: import('./long-text/contract').LongTextApi;");
  });
});
