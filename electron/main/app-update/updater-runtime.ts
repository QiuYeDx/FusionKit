import { createRequire } from 'node:module';
import type { AppUpdater, NsisUpdater } from 'electron-updater';
import type { UpdaterClasses } from './provider';

export interface ElectronUpdaterRuntime extends UpdaterClasses {
  /** electron-updater's own updater for this platform, created on first use. */
  readonly autoUpdater: AppUpdater;
  readonly NsisUpdater: typeof NsisUpdater;
  /** The Chromium-backed HTTP client electron-updater uses (its `electron-updater` session). */
  readonly ElectronHttpExecutor: new () => unknown;
}

/**
 * electron-updater is loaded at runtime (it is not bundled), and js-yaml is resolved next to it:
 * the same parser it reads latest.yml with, without FusionKit depending on it directly.
 */
export function loadElectronUpdater(): ElectronUpdaterRuntime {
  const require = createRequire(import.meta.url);
  const updaterModule = require('electron-updater') as typeof import('electron-updater');
  const besideUpdater = createRequire(require.resolve('electron-updater'));
  const yaml = besideUpdater('js-yaml') as { load(text: string): unknown };
  return {
    get autoUpdater() { return updaterModule.autoUpdater; },
    NsisUpdater: updaterModule.NsisUpdater,
    Provider: updaterModule.Provider,
    CancellationToken: updaterModule.CancellationToken,
    parseYaml: text => yaml.load(text),
    get ElectronHttpExecutor() {
      return (require('electron-updater/out/electronHttpExecutor') as { ElectronHttpExecutor: new () => unknown }).ElectronHttpExecutor;
    },
  };
}
