# FK-PIT-0199: Windows taskbar default icon from AUMID mismatch and pinned shortcuts

## Area

Electron / Windows packaging

## Triggers

taskbar icon,default electron icon,AppUserModelId,setAppUserModelId,pinned shortcut,Electron.lnk,window icon correct,dev taskbar

## Symptoms

On Windows 10/11 the taskbar button for FusionKit (dev or packaged) shows the default Electron icon (black electron logo) while the window's own `WM_SETICON` image is the correct FusionKit logo. Icon files, `BrowserWindow` `icon` paths, `nativeImage` decoding, and electron-builder `win.icon` / NSIS icon settings are all valid — replacing them changes nothing.

## Root cause

Three facts interact:

1. `electron/main/index.ts` runs `app.setAppUserModelId(app.getName())`, so the running process advertises the bare AUMID `"FusionKit"` (`productName`).
2. electron-builder NSIS sets the installed shortcuts' AUMID to `${APP_ID}` (`com.fusionkit.app`) via `WinShell::SetLnkAUMI` (see app-builder-lib `templates/nsis/installer.nsh`). The process AUMID therefore never matches the installer's shortcuts.
3. When the user pins the running window (taskbar/Start right-click), Windows creates a `.lnk` that inherits the process AUMID at pin time. On this machine that produced:
   - `Start Menu\Programs\Electron.lnk` (AUMID `FusionKit`, target `node_modules\...\electron.exe`, default Electron icon)
   - `Start Menu\Programs\FusionKit.lnk` (AUMID `FusionKit`, target a previously installed `FusionKit.exe`)

   The Windows taskbar resolves a window's button icon by AUMID *before* falling back to the window icon. With AUMID `"FusionKit"` it binds to one of those pinned `.lnk` files and shows that shortcut's icon — i.e. the default Electron icon — even though `WM_GETICON` on the window returns the correct FusionKit image.

## Do

- Keep the process AUMID identical to electron-builder's `appId` (`com.fusionkit.app`), e.g. `app.setAppUserModelId("com.fusionkit.app")` or derive it from one shared constant used by both `electron-builder.*.json` and main-process startup.
- To fix existing machines, delete the orphaned pinned shortcuts whose AUMID equals the bare product name (`Electron.lnk`, user-level `FusionKit.lnk` in `%APPDATA%\Microsoft\Windows\Start Menu\Programs`); the taskbar then falls back to the window icon / the installer's own shortcuts.
- Diagnose with evidence, not guesswork: scan `.lnk` files for `System.AppUserModel.ID` (Shell COM `ExtendedProperty`) plus `TargetPath`/`IconLocation`, and extract the live window icon with `WM_GETICON` + `GetDIBits` to confirm whether the window image itself is correct before touching icon assets.

## Avoid

- Do not use `app.getName()`/bare `productName` as the AUMID while electron-builder uses `appId` for shortcuts; the two namespaces must agree.
- Do not diagnose taskbar icons by only auditing ICO bytes, `BrowserWindow` icon options, or builder `win.icon` config — a window can hold a perfectly correct `ICON_BIG` while the taskbar displays a shortcut's icon resolved by AUMID.
- Do not pin a dev window (its `.lnk` inherits the dev AUMID and points at `node_modules`' electron.exe); the stray shortcut outlives the dev session and hijacks the AUMID.

## Validation

- `Get-Process electron` (dev) → enumerate windows → `SendMessage(hwnd, WM_GETICON, ICON_BIG, 0)`; save the HICON via `GetIconInfo`/`GetDIBits` and confirm the FusionKit logo renders (proves window icon is fine).
- Scan shortcuts for AUMID collisions:
  `Shell.Application` namespace parse + `ExtendedProperty("System.AppUserModel.ID")` over Desktop, Public Desktop, both Start Menu roots, and `...\User Pinned\`; any `.lnk` sharing the process AUMID is a taskbar-icon source.
- After unifying the AUMID (and removing stale `.lnk` files), relaunch dev and confirm the taskbar shows the FusionKit logo; relaunch the installed app and confirm its taskbar button groups with the installer shortcuts.

## Related files

- `electron/main/index.ts` (`app.setAppUserModelId(app.getName())`, `BrowserWindow` icon)
- `electron-builder.json`, `electron-builder.subtitle-studio.json` (`appId`, `win.icon`, NSIS icons)
- `app-builder-lib` `templates/nsis/installer.nsh` (`WinShell::SetLnkAUMI "${APP_ID}"`)
