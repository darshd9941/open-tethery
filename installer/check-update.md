# "Update available" design (not implemented yet)

Goal: the panel tells you when a newer Open Tethery exists. It never downloads or installs by itself.

## Source of truth

A small JSON file attached to each GitHub release as `latest.json` and reachable at a stable URL:
`https://github.com/<owner>/open-tethery/releases/latest/download/latest.json`

```json
{
  "version": "0.3.0",
  "released": "2026-12-20",
  "url": "https://github.com/<owner>/open-tethery/releases/tag/v0.3.0",
  "installer": "https://github.com/<owner>/open-tethery/releases/download/v0.3.0/OpenTetherySetup.exe",
  "sha256": "<hex of OpenTetherySetup.exe>",
  "notes": "One line of what changed."
}
```

The release workflow writes `version` from `installer/version.txt` (single source of truth, also used by the .iss).

## Who checks

The **helper** does the fetch (the CEP panel can, but the helper is always running and has no CORS or sandbox limits):

- `GET /api/update` (loopback only) returns `{current, latest, available, url, notes, checkedAt}`.
- The helper fetches `latest.json` at start-up and then at most once every 24 h, with a 5 s timeout. Any error is
  ignored and cached as "unknown"; no retry storm. No identifiers are sent (plain GET, no query string, generic User-Agent `OpenTethery/<version>`).
- Version compare: dotted numbers, `latest > current`.
- A setting "Check for updates" (default on) turns the request off completely.

## What the user sees

The panel status area shows a small line "Update available: 0.3.0 (notes)" with a button that opens `url` in the
default browser (CEP `cep.util.openURLInDefaultBrowser`). The user downloads and runs `OpenTetherySetup.exe`, which
closes the Adobe apps (with consent) and upgrades in place (same `AppId`).

## Later

- Verify `sha256` and offer "Download and run" from the helper.
- Signed installer so SmartScreen does not warn.
