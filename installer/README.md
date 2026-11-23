# installer/

Everything that puts Open Tethery on a PC. Run all commands from the repo root in PowerShell.

| File | What it does |
|---|---|
| `version.txt` | The one version number (read by the .iss; keep `package.json` equal, a test checks it). |
| `common.ps1` | Shared constants (ids, port, rule name, paths) and helpers. Dot-sourced by the dev scripts. |
| `build-helper-exe.ps1` / `.js` | Builds `helper/` into `installer\dist\helper\OpenTetheryHelper.exe` with Node SEA. |
| `dev-install.ps1` | The "dev install" (M0): installs everything below on this PC, one UAC prompt, idempotent. |
| `dev-uninstall.ps1` | Removes all of it. Also `dev-install.ps1 -Uninstall`. |
| `start-helper.vbs` | Starts the helper hidden (no console window); used by the Run entry. |
| `OpenTethery.iss` | Inno Setup 6 script for the real `OpenTetherySetup.exe` (M8). |
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

# real installer (Inno Setup 6 installed; needs steps 1, the built .prm and a .ccx in installer\dist first)
"C:\Program Files (x86)\Inno Setup 6\ISCC.exe" installer\OpenTethery.iss
```

## What dev-install does

1. Self-elevates once. Stops a running helper. Warns if Adobe apps are open.
2. Copies `OpenTetheryHelper.exe`, `viewer\`, `profiles\` (from `installer\dist\helper`) to `%LOCALAPPDATA%\OpenTethery`.
   If the exe is not built it falls back to `node.exe` + a copy of `helper\` (runs `npm install --omit=dev`).
3. Copies `panels\cep` to `%APPDATA%\Adobe\CEP\extensions\com.opentethery.panel`; deletes `com.screenlive.video`;
   sets `PlayerDebugMode=1` under `HKCU\Software\Adobe\CSXS.9` to `CSXS.13`.
4. Copies `build\native\Release\OpenTetheryTransmit.prm` (and `.aex` if any) to
   `C:\Program Files\Adobe\Common\Plug-ins\<newest>\MediaCore\OpenTethery` (default `7.0`).
5. Zips `panels\uxp-photoshop` to `installer\dist\OpenTetheryPhotoshop.ccx` and installs it with
   `UnifiedPluginInstallerAgent.exe /install` if present, otherwise prints how to load it.
6. Firewall: inbound TCP 47825, Private profile, rule "Open Tethery Helper"; removes old "Live Video Preview*" / "Live Phone Preview*" rules.
7. `HKCU\...\Run\OpenTetheryHelper` = `wscript.exe "%LOCALAPPDATA%\OpenTethery\start-helper.vbs"`.
8. Starts the helper and polls `http://127.0.0.1:47825/health`. Log: `%LOCALAPPDATA%\OpenTethery\install.log`.

Uninstall reverses each step and deletes `%LOCALAPPDATA%\OpenTethery` (incl. the log). `PlayerDebugMode` stays on
unless `-RemoveDebugMode` (other CEP panels may need it).

## Helper exe: how it is built

`node installer/build-helper-exe.js` (what the .ps1 runs):

1. Finds the entry (`helper/package.json` "main", else `src/index.js`, `index.js`, ...).
2. Bundles to `installer\dist\build\helper.bundle.js` with esbuild (`installer/package.json` devDependency;
   `ws`'s optional `bufferutil`/`utf-8-validate` stay external). Without esbuild a small built-in CommonJS bundler is used.
3. Writes `sea-config.json`, runs `node --experimental-sea-config` to make the blob.
4. Copies `node.exe` to `OpenTetheryHelper.exe`, runs `signtool remove /s` if signtool is found, then `npx postject`
   with the standard `NODE_SEA_FUSE_...` sentinel.
5. Copies `viewer\` and `helper\profiles\` (if present) **next to the exe**; they are not inside it.

At run time the bundle sets, only when running as a SEA: `OT_VIEWER_DIR=<exeDir>\viewer`,
`OT_PROFILES_DIR=<exeDir>\profiles`, `OT_EXE_DIR=<exeDir>` (existing values win). So the helper must resolve
the viewer from `OT_VIEWER_DIR` first and must not rely on `__dirname` for data files (it does not exist as a real path in a SEA).
`--bundle-only` stops after step 3 (works anywhere). Linux smoke test of the real SEA: `OT_TEST_SEA=1 npm test`.

## Installer (.iss) notes

- `PrivilegesRequired=admin`: the firewall rule and the Program Files MediaCore folder need admin anyway, so one UAC "Yes"
  is simpler than a per-user install that elevates half way. Files still go to `%LOCALAPPDATA%`, `%APPDATA%`, HKCU.
  Caveat: if another admin account approves the prompt, those per-user paths are that admin's.
- Closes Adobe apps: `CloseApplications=yes` (Restart Manager) plus a `[Code]` check by process name for
  Adobe Premiere Pro.exe, AfterFX.exe, Photoshop.exe that blocks until they are closed.
- Start menu "Uninstall Open Tethery"; version from `version.txt`; same `AppId` so a newer setup upgrades in place.
- Needs before compiling: `installer\dist\helper\*` (build script), `panels\cep`, `build\native\Release\OpenTetheryTransmit.prm`,
  `installer\dist\OpenTetheryPhotoshop.ccx` (created by dev-install, or zip `panels\uxp-photoshop` and rename).

## Needs PC test

- [ ] `build-helper-exe.ps1` on Windows: signtool removal, postject on node.exe, exe starts, `/health` works, viewer served from `<exeDir>\viewer`.
- [ ] `dev-install.ps1 -WhatIf` output reads right; real run needs exactly one UAC prompt; second run changes nothing harmful (idempotent).
- [ ] No PowerShell was run on Linux (pwsh missing): all `.ps1` are only text-checked here. Expect small syntax or cmdlet slips.
- [ ] Helper panel/Run start: `start-helper.vbs` launches hidden; after reboot the helper is up; Task Manager shows it.
- [ ] CEP panel appears in Premiere and After Effects (CSXS 9 to 13 covers 2027?); old `com.screenlive.video` gone.
- [ ] MediaCore path: confirm `...\Plug-ins\7.0\MediaCore\OpenTethery\OpenTetheryTransmit.prm`; Premiere lists the plug-in.
- [ ] Photoshop: UPIA `/install` of the .ccx works (flags unverified) and `/remove <id>` works; else UXP Developer Tool.
- [ ] Firewall rule exists (Private only); phone on Wi-Fi reaches port 47825; old rules removed.
- [ ] `dev-uninstall.ps1` leaves nothing: folder, Run value, rule, panel, MediaCore folder.
- [ ] Inno Setup: compiles, `skipifdoesntexist`/`skipifsourcedoesntexist` flags behave, Adobe-app check works, Start menu uninstall removes all, upgrade over an existing install.
- [ ] Windows SmartScreen / antivirus reaction to an unsigned SEA exe and setup.
