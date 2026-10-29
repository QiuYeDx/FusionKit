// Loaded with `-r` into every guarded Electron launch (scripts/guard-electron-launch.mjs), before Electron's
// default app loads FusionKit. Electron reports a missing app entry, and any uncaught error in the main
// process, with dialog.showErrorBox: a modal box on the developer's screen that the quiet window mode cannot
// hide, one per launch. Here those reports go to stderr, one tagged line each, and a launch whose main entry
// is missing (for example while `vite build` rewrites dist-electron/) exits at once.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const REPORT_PREFIX = '[electron-launch-guard]';
// The launcher's report file for this app (scripts/guard-electron-launch.mjs), if it passed one.
const REPORT_LOG_ENV = 'FUSIONKIT_ERROR_BOX_LOG';

/** The app path Electron's default app takes from `argv` (process.argv without the executable). */
function appArgument(argv) {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '-r' || arg === '--require') index++;
    else if (arg.startsWith('--app=')) return arg.slice('--app='.length);
    else if (arg === '--version' || arg === '-v') return undefined;
    else if (!arg.startsWith('-')) return arg;
  }
  return undefined;
}

const isFile = file => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    // Missing, or being deleted (Windows reports EPERM then): not loadable either way.
    return false;
  }
};

/** Why the app named in `argv` cannot be loaded from `cwd`, or null when its main entry exists. */
function missingAppEntry(argv, cwd) {
  const app = appArgument(argv);
  if (!app) return null;
  const appPath = path.resolve(cwd, app);
  let entry = appPath;
  try {
    if (fs.statSync(appPath).isDirectory()) {
      const manifest = path.join(appPath, 'package.json');
      entry = path.resolve(appPath, (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).main) || 'index.js');
    }
  } catch {
    // A missing app path, or an unreadable package.json, is reported below.
  }
  if ([entry, `${entry}.js`, `${entry}.cjs`, `${entry}.mjs`, path.join(entry, 'index.js')].some(isFile)) return null;
  return `The Electron app entry ${entry} does not exist.`;
}

function reportErrorBoxToStderr(title, content) {
  const report = `${title}\n${content}`.split(/\r?\n/).map(line => `${REPORT_PREFIX} ${line}\n`).join('');
  process.stderr.write(report);
  if (!process.env[REPORT_LOG_ENV]) return;
  try {
    fs.appendFileSync(process.env[REPORT_LOG_ENV], report);
  } catch {
    // stderr still has it.
  }
}

if (process.versions.electron && process.type === 'browser') {
  try {
    require('electron').dialog.showErrorBox = reportErrorBoxToStderr;
  } catch (error) {
    process.stderr.write(`${REPORT_PREFIX} could not replace dialog.showErrorBox: ${error}\n`);
  }
  let missing;
  try {
    missing = missingAppEntry(process.argv.slice(1), process.cwd());
  } catch (error) {
    missing = `Could not check the Electron app entry: ${error}.`;
  }
  if (missing) {
    process.stderr.write(`${REPORT_PREFIX} ${missing} Build the test bundle first: pnpm run pretest\n`);
    process.exit(1);
  }
}

module.exports = { missingAppEntry, REPORT_LOG_ENV, REPORT_PREFIX };
