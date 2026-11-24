# installer/

Everything that puts Pocket Monitor on a PC. Run all commands from the repo root in PowerShell.

| File | What it does |
|---|---|
| `version.txt` | The one version number (read by the .iss; keep `package.json` equal, a test checks it). |
| `common.ps1` | Shared constants (ids, port, rule name, paths) and helpers. Dot-sourced by the dev scripts. |
| `build-helper-exe.ps1` / `.js` | Builds `helper/` into `installer\dist\helper\PocketMonitorHelper.exe` with Node SEA. |
| `dev-install.ps1` | The "dev install" (M0): installs everything below on this PC, one UAC prompt, idempotent. |
| `dev-uninstall.ps1` | Removes all of it. Also `dev-install.ps1 -Uninstall`. |
| `start-helper.vbs` | Starts the helper hidden (no console window); used by the Run entry. |
| `PocketMonitor.iss` | Inno Setup 6 script for the real `PocketMonitorSetup-<version>.exe`. |
| `build-release.ps1` | ONE command that builds the whole release (see "Make a release"). |
| `sign-panel.ps1` | Signs the CEP panel into `dist\PocketMonitorPanel.zxp` (+ unpacked `dist\panel\`) with ZXPSignCmd. |
| `check-update.md` | Design for the "update available" check (not built). |
| `test/static.test.js` | Linux tests (`cd installer && npm install && npm test`). |

## One-line commands (user's PC)

```powershell
# 1. build the helper exe (once, and after helper/viewer changes). Needs Node 22 + internet.
powershell -ExecutionPolicy Bypass -File installer\build-helper-exe.ps1

# 2. install everything (dry run first: -WhatIf prints every action, changes nothing)
powershell -ExecutionPolicy Bypass -File installer\dev-install.ps1 -WhatIf
powershell -ExecutionPolicy Bypass -File installer\dev-install.ps1

# options: -SkipNative (no Transmit plug-in), -SkipPhotoshop, -NoStart, -PrmPath <x.prm>, -CcxPath <x.ccx>
# remove everything
powershell -ExecutionPolicy Bypass -File installer\dev-uninstall.ps1

# real installer: see "Make a release" below
```

## Make a release

One command, on a Windows PC with the prerequisites:

```powershell
powershell -ExecutionPolicy Bypass -File installer\build-release.ps1
```

Result: `installer\dist\PocketMonitorSetup-<version>.exe` and `.sha256` (version comes from `product.json`).
Users download that one file, double-click, say Yes once; no PlayerDebugMode or developer settings (the panel is signed).
They get the panel in Premiere Pro and After Effects (Window > Extensions), the Transmit plug-in, the helper (starts with Windows),
firewall rules, optional Photoshop plug-in (checkbox), and a Start-menu uninstall. Running a newer setup upgrades in place.

Prerequisites (once):

1. Node 22 (`winget install OpenJS.NodeJS.LTS`).
2. Visual Studio 2022 with "Desktop development with C++" (MSBuild is found with vswhere).
3. Inno Setup 6: `winget install JRSoftware.InnoSetup`.
4. Adobe ZXPSignCmd: get it from https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD, save as
   `%USERPROFILE%\.pocketmonitor\ZXPSignCmd.exe` (or set `PM_ZXPSIGNCMD`, or `PM_ZXPSIGNCMD_URL` to auto-download).
   Then create the panel certificate once: `powershell -File installer\sign-panel.ps1 -CreateCert`
   (stored in `%USERPROFILE%\.pocketmonitor\panel-cert.p12`, outside the repo; back it up; set `PM_PANEL_CERT_PASS` to skip the password prompt).
5. The licensed Adobe Premiere Pro C++ SDK unzipped into `sdk\` (git-ignored) or `PREMIERE_SDK` pointing at its `Examples` folder.
6. Optional: `PM_SIGN_CERT` (.pfx path) and `PM_SIGN_PASS` to Authenticode-sign the helper exe, .prm and setup with signtool
   (avoids SmartScreen warnings). Without them the build says so and continues.

Steps the script runs: branding check, `npm ci`, helper exe (SEA), MSBuild Transmit plug-in, sign panel .zxp, pack Photoshop .ccx,
compile .iss, optional Authenticode, SHA256. It stops with a plain-English message at the first problem.
CI (`.github/workflows/release.yml`, on tags `v*`) only runs the tests and attaches the helper exe and .ccx: the final setup is built
locally because the Adobe SDK is licensed and the signing certificates are private. `.github/workflows/ci.yml` runs `npm run test:all` on PRs.

## What dev-install does

1. Self-elevates once. Stops a running helper. Warns if Adobe apps are open.
2. Copies `PocketMonitorHelper.exe`, `viewer\`, `profiles\` (from `installer\dist\helper`) to `%LOCALAPPDATA%\PocketMonitor`.
   If the exe is not built it falls back to `node.exe` + a copy of `helper\` (runs `npm install --omit=dev`).
3. Copies `panels\cep` to `%APPDATA%\Adobe\CEP\extensions\com.pocketmonitor.panel`; deletes `com.screenlive.video`;
   sets `PlayerDebugMode=1` under `HKCU\Software\Adobe\CSXS.9` to `CSXS.13`.
4. Copies `build\native\Release\PocketMonitorTransmit.prm` (and `.aex` if any) to
   `C:\Program Files\Adobe\Common\Plug-ins\<newest>\MediaCore\PocketMonitor` (default `7.0`).
5. Zips `panels\uxp-photoshop` to `installer\dist\PocketMonitorPhotoshop.ccx` and installs it with
   `UnifiedPluginInstallerAgent.exe /install` if present, otherwise prints how to load it.
6. Firewall: inbound TCP 47825, Private profile, rule "Pocket Monitor Helper"; removes old "Live Video Preview*" / "Live Phone Preview*" rules.
7. `HKCU\...\Run\PocketMonitorHelper` = `wscript.exe "%LOCALAPPDATA%\PocketMonitor\start-helper.vbs"`.
8. Starts the helper and polls `http://127.0.0.1:47825/health`. Log: `%LOCALAPPDATA%\PocketMonitor\install.log`.

Uninstall reverses each step and deletes `%LOCALAPPDATA%\PocketMonitor` (incl. the log). `PlayerDebugMode` stays on
unless `-RemoveDebugMode` (other CEP panels may need it).

## Helper exe: how it is built

`node installer/build-helper-exe.js` (what the .ps1 runs):

1. Finds the entry (`helper/package.json` "main", else `src/index.js`, `index.js`, ...).
2. Bundles to `installer\dist\build\helper.bundle.js` with esbuild (`installer/package.json` devDependency;
   `ws`'s optional `bufferutil`/`utf-8-validate` stay external). Without esbuild a small built-in CommonJS bundler is used.
3. Writes `sea-config.json`, runs `node --experimental-sea-config` to make the blob.
4. Copies `node.exe` to `PocketMonitorHelper.exe`, runs `signtool remove /s` if signtool is found, then `npx postject`
   with the standard `NODE_SEA_FUSE_...` sentinel.
5. Copies `viewer\` and `helper\profiles\` (if present) **next to the exe**; they are not inside it.

At run time the bundle sets, only when running as a SEA: `OT_VIEWER_DIR=<exeDir>\viewer`,
`OT_PROFILES_DIR=<exeDir>\profiles`, `OT_EXE_DIR=<exeDir>` (existing values win). So the helper must resolve
the viewer from `OT_VIEWER_DIR` first and must not rely on `__dirname` for data files (it does not exist as a real path in a SEA).
`--bundle-only` stops after step 3 (works anywhere). Linux smoke test of the real SEA: `OT_TEST_SEA=1 npm test`.

## Installer (.iss) notes

- Release setup installs the SIGNED panel (`dist\panel`, the unpacked .zxp) to `%APPDATA%\Adobe\CEP\extensions\<id>`; it writes no PlayerDebugMode. `dev-install.ps1` still installs the unsigned folder and sets it.
- Components: "Premiere Pro and After Effects" (always) and "Photoshop" (optional). Uninstall also removes legacy Open Tethery and Live Preview leftovers.
- `PrivilegesRequired=admin`: the firewall rule and the Program Files MediaCore folder need admin anyway, so one UAC "Yes"
  is simpler than a per-user install that elevates half way. Files still go to `%LOCALAPPDATA%`, `%APPDATA%`, HKCU.
  Caveat: if another admin account approves the prompt, those per-user paths are that admin's.
- Closes Adobe apps: `CloseApplications=yes` (Restart Manager) plus a `[Code]` check by process name for
  Adobe Premiere Pro.exe, AfterFX.exe, Photoshop.exe that blocks until they are closed.
- Start menu "Uninstall Pocket Monitor"; version from `version.txt`; same `AppId` so a newer setup upgrades in place.
- Needs before compiling (build-release.ps1 makes all): `installer\dist\helper\*`, `installer\dist\panel\*`, `build\native\Release\PocketMonitorTransmit.prm`, `installer\dist\PocketMonitorPhotoshop.ccx`.

## Needs PC test

- [ ] `build-helper-exe.ps1` on Windows: signtool removal, postject on node.exe, exe starts, `/health` works, viewer served from `<exeDir>\viewer`.
- [ ] `dev-install.ps1 -WhatIf` output reads right; real run needs exactly one UAC prompt; second run changes nothing harmful (idempotent).
- [ ] No PowerShell was run on Linux (pwsh missing): all `.ps1` are only text-checked here. Expect small syntax or cmdlet slips.
- [ ] Helper panel/Run start: `start-helper.vbs` launches hidden; after reboot the helper is up; Task Manager shows it.
- [ ] CEP panel appears in Premiere and After Effects (CSXS 9 to 13 covers 2027?); old `com.screenlive.video` gone.
- [ ] MediaCore path: confirm `...\Plug-ins\7.0\MediaCore\PocketMonitor\PocketMonitorTransmit.prm`; Premiere lists the plug-in.
- [ ] Photoshop: UPIA `/install` of the .ccx works (flags unverified) and `/remove <id>` works; else UXP Developer Tool.
- [ ] Firewall rule exists (Private only); phone on Wi-Fi reaches port 47825; old rules removed.
- [ ] `dev-uninstall.ps1` leaves nothing: folder, Run value, rule, panel, MediaCore folder.
- [ ] Inno Setup: compiles, `skipifdoesntexist`/`skipifsourcedoesntexist` flags behave, Adobe-app check works, Start menu uninstall removes all, upgrade over an existing install.
- [ ] Windows SmartScreen / antivirus reaction to an unsigned SEA exe and setup.
- [ ] `build-release.ps1` end to end on Windows (vswhere/MSBuild lookup, ISCC lookup, every plain-English failure message).
- [ ] `sign-panel.ps1 -CreateCert` then a normal run: ZXPSignCmd argument order/flags (`-selfSignedCert`, `-sign ... -tsa`, `-verify`), timestamp server reachable.
- [ ] Signed panel loads in Premiere Pro and After Effects with PlayerDebugMode OFF (delete the CSXS keys first) and appears under Window > Extensions > Pocket Monitor.
- [ ] The panel still works when installed from the unpacked .zxp (no `.debug`, no node_modules; helper launch from `start-helper.vbs`).
- [ ] Setup: components page (Photoshop unticked skips the .ccx), license page, upgrade over an older build, uninstall removes legacy Open Tethery leftovers.
- [ ] Authenticode signing with `PM_SIGN_CERT`/`PM_SIGN_PASS` and SmartScreen behaviour for the signed and unsigned setup.
- [ ] GitHub release workflow on a test tag (windows-latest: helper exe + ccx artifacts).
