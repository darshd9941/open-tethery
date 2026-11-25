<div align="center">

# Pocket Monitor

**Turn your phone into a live second monitor for Premiere Pro, After Effects, and Photoshop.**  
Scan a QR code, press play (or paint a layer), and see your work live on your phone — with sound, realistic social-app overlays, safe zones, scopes, and playback controls. **Nothing to install on your phone. 100% local over your Wi-Fi.**

[![Download for Windows](https://img.shields.io/badge/Download_for_Windows-PocketMonitorSetup.exe-0f9d8f?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/darshd9941/open-tethery/releases/latest)
[![Get Pro on Gumroad](https://img.shields.io/badge/Pro_%26_1--Click_Installer-Gumroad-ff90e8?style=for-the-badge&logo=gumroad&logoColor=black)](https://darshandj.gumroad.com/l/pocket-monitor)
[![Help & Website](https://img.shields.io/badge/Guide_%26_Help-Website-1f2937?style=for-the-badge)](https://darshd9941.github.io/open-tethery/)

![Windows 10 | 11](https://img.shields.io/badge/Windows-10%20%7C%2011%20(64--bit)-0078D6)
![Premiere Pro 2024+](https://img.shields.io/badge/Premiere%20Pro-2024%2B-9999FF)
![After Effects 2024+](https://img.shields.io/badge/After%20Effects-2024%2B-9999FF)
![Photoshop 2023+](https://img.shields.io/badge/Photoshop-2023%2B-31A8FF)
![Any Phone Browser](https://img.shields.io/badge/Phone-iPhone%20%7C%20Android%20%7C%20Any%20Browser-lightgrey)

<br>

<img src="docs/images/panel.jpg" alt="Pocket Monitor panel in Premiere Pro showing a QR code and connected phones" height="400">
&nbsp;&nbsp;
<img src="docs/images/reels.jpg" alt="Phone showing the live edit inside an Instagram Reels overlay" height="400">
&nbsp;&nbsp;
<img src="docs/images/scopes.jpg" alt="Phone showing scopes and playback controls" height="400">

[Install in 60 seconds](#install-in-60-seconds) · [What it does](#what-it-does) · [How to use it](#how-to-use-it) · [Troubleshooting](#troubleshooting) · [How it works](#how-it-works) · [Developers](#for-developers)

</div>

---

## Why Pocket Monitor?

Most videos and graphics are watched on a **phone**, but edited on a **desktop monitor**. Instead of exporting and AirDropping/WhatsApping test files to your phone ten times a day, Pocket Monitor streams your live canvas or Program Monitor straight to your phone browser over your own Wi-Fi — so you can check framing, text legibility, social-app UI overlap, and colour in real time.

## Install in 60 seconds

1. **Download [`PocketMonitorSetup.exe`](https://github.com/darshd9941/open-tethery/releases/latest)** from the latest GitHub Release.
2. **Close Premiere Pro, After Effects, and Photoshop.**
3. **Run the installer** and click **Yes** when Windows asks for permission.

That's it — the installer sets up:
- The **Premiere Pro / After Effects** panel and native Mercury Transmit video engine
- The **Photoshop** live-canvas plug-in
- The lightweight background helpers (separate processes for Video and Photoshop so both can run at once without colliding)
- Private-network Windows Firewall rules and a standard Windows uninstaller

### One-time step for Premiere Pro & After Effects

Adobe only sends video to external monitor plug-ins that you tick in Preferences (Photoshop needs no extra setup):

| App | Open this menu | Tick this box |
|---|---|---|
| **Premiere Pro** | Edit › Preferences › **Playback** › Video Device | **Pocket Monitor** |
| **After Effects** | Edit › Preferences › **Video Preview** | **Pocket Monitor** |
| **Photoshop** | *(No setup needed — just open a document)* | **Plugins › Pocket Monitor** |

> If you forget, the Premiere/AE panel detects it and shows the exact clicks to turn it on.

<details>
<summary><b>Uninstall</b></summary>

Open Windows **Settings › Apps › Pocket Monitor › Uninstall**. This cleanly removes the panels, plug-ins, helpers, startup entry, and firewall rules.
</details>

---

## What it does

| Feature | Details |
|---|---|
| **Live Premiere & AE playback** | Streams every Program Monitor frame in real time — grades, titles, trims, multicam, and scrubbing (H.264 over WebRTC with automatic JPEG fallback). |
| **Photoshop live canvas** | Streams your active PSD/canvas automatically as you paint, move layers, or adjust colour — with sRGB and Display P3 ICC profile support. |
| **Synced timeline audio** | Hear your Premiere Pro timeline on your phone speaker in sync *(After Effects does not send audio to Transmit plug-ins)*. |
| **Social-app overlays + Safe Zones** | Preview your frame inside **Instagram Reels / Feed / Story, TikTok, YouTube / Shorts, X, Facebook, Snapchat, Pinterest, Reddit**. Switch between **UI preview** (realistic modern icons, gradient scrims, custom `@handle` & avatar) and **Safe zones** (hatched red danger areas + emerald safe-area brackets). |
| **Scopes & exposure** | Histogram (luma, RGB, parade), waveform, vectorscope, audio meters, false colour, and zebras — all rendered on the phone so your PC does zero extra work. |
| **Framing guides** | Title/action safe, rule of thirds, centre mark, custom grid, and letterbox mattes (`2.39`, `1.85`, `4:5`, `9:16`, etc.). |
| **Phone playback controls** | Play, pause, step 1 frame, jump ±5 s, and scrub from the phone (toggleable in the panel). |
| **Multi-phone & share** | Connect several phones at once, kick a device or rotate the 4-letter code anytime, and save or share the current frame (clean or with overlays). |
| **100% private & local** | Everything stays on your local Wi-Fi, hotspot, USB tether, or Tailscale. No account, no cloud server, no watermark. |

### Compatibility

| App | Version | Where to open it | Live picture | Sound |
|---|---|---|---|---|
| **Premiere Pro** | 2024 or newer | Window › Extensions › **Pocket Monitor** | Yes | Yes |
| **After Effects** | 2024 or newer | Window › Extensions › **Pocket Monitor** | Yes | No (Adobe limit) |
| **Photoshop** | 2023 (24.0) or newer | Plugins › **Pocket Monitor** | Live canvas | n/a |

- **PC:** Windows 10 or 11 (64-bit). macOS is planned.
- **Phone / tablet:** Any modern browser (iPhone Safari, Android Chrome, Brave, etc.) on the same network.

---

## How to use it

1. **Open the panel** in your Adobe app:
   - Premiere Pro / After Effects: **Window › Extensions › Pocket Monitor**
   - Photoshop: **Plugins › Pocket Monitor**
2. **Scan the QR code** with your phone camera (or type the address and 4-letter code).
3. **Press Play** in Premiere/AE — or edit any layer in Photoshop. Tap **Sound** on the phone to unmute audio.

Tap the picture on your phone to show or hide the controls:

| Control | What it does |
|---|---|
| `⏮` `⏪5s` `◀1f` `▶` `1f▶` `5s⏩` `⏭` + scrub bar | Control playback (when **Allow control from phones** is enabled in the panel) |
| **Frame** | Pick a social platform overlay; toggle **UI preview** vs **Safe zones**; customize your `@handle`, caption & avatar |
| **Guides** | Safe areas, thirds, custom grid, letterbox mattes |
| **Scopes** | Histogram, waveform, vectorscope, audio meters (drag to move, S / M / L to resize) |
| **False colour / Zebras** | Live exposure checks |
| **Sound · Stats · Save frame · Share · Full screen** | Bottom utility row |

> **Tip:** On iPhone Safari, tap **Share › Add to Home Screen** to run the viewer full-screen like a native app.

---

## Troubleshooting

<details>
<summary><b>The phone can't open the page</b></summary>

- Make sure your phone and PC are on the **same Wi-Fi/LAN** (guest Wi-Fi and some office networks isolate devices — use a phone hotspot, USB tether, or Tailscale instead and pick it in the panel's **Connection** menu).
- Ensure Windows Firewall allows **TCP 47825** (Premiere/AE) and **TCP 47823** (Photoshop) on **Private** networks. If your Windows network profile is set to *Public*, switch it to *Private*.
</details>

<details>
<summary><b>The phone says "Connected, waiting for picture"</b></summary>

- **Premiere / AE:** Enable **Pocket Monitor** in Preferences (see [One-time step](#one-time-step-for-premiere-pro--after-effects)) and press Play or scrub once.
- **Photoshop:** Open a document (or click **Send now** in the Photoshop panel).
</details>

<details>
<summary><b>"Pocket Monitor" is missing from Window › Extensions</b></summary>

Restart Premiere Pro / After Effects after installing. For repository dev installs, `installer\dev-install.ps1` sets `PlayerDebugMode=1` automatically.
</details>

<details>
<summary><b>No sound on the phone</b></summary>

Tap **Sound** on the phone (mobile browsers require a tap to unmute) and check the phone isn't on silent. After Effects does not send audio to Transmit plug-ins.
</details>

<details>
<summary><b>Need help? Send a diagnostic report</b></summary>

Press **Send report** in the Premiere/AE panel to save a local `.zip` of logs and network details (nothing is uploaded; session codes are redacted), and attach it to a [GitHub Issue](https://github.com/darshd9941/open-tethery/issues).
</details>

---

## How it works

```text
 Premiere Pro / After Effects                    Photoshop
 ┌────────────────────────────────┐              ┌──────────────────────────────┐
 │ CEP Panel (QR, codes, control) │              │ UXP Panel (live canvas JPEG) │
 │ C++ Transmit plug-in (H.264,   │              │ HTTP POST -> 127.0.0.1:47823 │
 │ JPEG, PCM -> 127.0.0.1:47826)  │              └──────────────┬───────────────┘
 └───────────────┬────────────────┘                             │
                 ▼                                              ▼
 ┌────────────────────────────────┐              ┌──────────────────────────────┐
 │ Video Helper (port 47825)      │              │ Photoshop Helper (port 47823)│
 │ WebRTC H.264 + JPEG + PCM      │              │ Dedicated isolated session   │
 └───────────────┬────────────────┘              └──────────────┬───────────────┘
                 └──────────────────┬───────────────────────────┘
                                    │ Your local Wi-Fi / hotspot / USB / Tailscale
                                    ▼
             Phone Browser: live picture, sound, overlays, scopes, controls
```

- Premiere Pro & After Effects (`:47825`) and Photoshop (`:47823`) run as **two completely independent helper processes**, so you can keep Premiere and Photoshop open at the same time with zero interference.
- The C++ Mercury Transmit plug-in encodes frames on its own thread with Windows Media Foundation GPU H.264 and drops frames rather than slowing down your timeline.
- Wire specs: [docs/PROTOCOL.md](docs/PROTOCOL.md) · [docs/transmit-protocol.md](docs/transmit-protocol.md).

---

## For developers

### Repository layout

| Folder | Purpose |
|---|---|
| [`helper/`](helper/) | Node 22 background helper (`--mode video` on `:47825`, `--mode photoshop` on `:47823`) |
| [`viewer/`](viewer/) | Phone web app (zero build step): WebRTC/JPEG player, audio sync, social overlays, guides, scopes |
| [`panels/cep/`](panels/cep/) | Premiere Pro & After Effects CEP panel |
| [`panels/uxp-photoshop/`](panels/uxp-photoshop/) | Photoshop UXP plug-in (`v0.3.4`) |
| [`native/transmit/`](native/transmit/) | Windows C++ Mercury Transmit plug-in (H.264, JPEG, PCM audio) |
| [`installer/`](installer/) | PowerShell dev install/uninstall, Node SEA helper `.exe` builder, Inno Setup release script |
| [`e2e/`](e2e/) | Playwright end-to-end tests |
| [`site/`](site/) | Project landing & help site (GitHub Pages) |

### Run & test locally (no Adobe apps needed)

```bash
npm run install:all
npm run test:all

# Terminal 1: start helper
OT_VIEWER_DIR=./viewer node helper/bin/open-tethery-helper.js

# Terminal 2: send fake Premiere frames
node helper/tools/fake-transmit.js
```

### Install from source on Windows

Requires [Node.js 22](https://nodejs.org/) (plus Visual Studio 2022 C++ & Adobe Premiere Pro C++ SDK only if building `native/transmit`):

```powershell
powershell -ExecutionPolicy Bypass -File installer\build-helper-exe.ps1
powershell -ExecutionPolicy Bypass -File installer\dev-install.ps1 -SkipNative
```

### Rebranding & Releases

- Product name, version, and IDs live in [`product.json`](product.json). Run `node tools/apply-branding.js` after editing it.
- Pushing a `v<version>` tag matching `product.json` triggers [`.github/workflows/release.yml`](.github/workflows/release.yml) to build and publish `PocketMonitorSetup-<version>.exe` automatically.

## Free vs. Pro Edition

Pocket Monitor's core is **free and open source forever** under the [GNU GPLv3](LICENSE).

| Edition | Price | What's included |
|---|---|---|
| **Open Source (GitHub)** | **Free forever** | Full Premiere Pro, After Effects & Photoshop live preview, synced audio, social overlays + safe zones, scopes, guides, playback controls, and full GPLv3 source code. |
| **[1-Click Installer (Gumroad)](https://darshandj.gumroad.com/l/pocket-monitor)** | **$5+ (pay what you want)** | 1-click Windows installer download on Gumroad + updates for this release line. |
| **[Pocket Monitor Pro (Early Access)](https://darshandj.gumroad.com/l/pocket-monitor)** | **$19 one-time** | Lifetime Pro access: upcoming code-signed Windows installer (no SmartScreen warning), upcoming macOS build, plus Pro features (custom brand/client overlay presets, multi-client review links, LUT preview). |

## License

Licensed under the [GNU General Public License v3.0](LICENSE).

---

<sub>Pocket Monitor is an independent open-source project, not affiliated with or endorsed by Adobe. Premiere Pro, After Effects, and Photoshop are trademarks of Adobe Inc. Social platform overlays are original vector drawings.</sub>
