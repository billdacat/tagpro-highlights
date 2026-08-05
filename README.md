# TagPro Highlights

Turn a [TagPro](https://tagpro.gg) replay into short, shareable highlight clips — flag captures, big returns, and other key moments — automatically detected from the game's raw replay data.

The project has two independent rendering pipelines plus one experimental side tool:

| Pipeline | Entry point | What it does |
|---|---|---|
| **Real-renderer export** (recommended) | `src/export-replay-clips.js` | Drives the actual TagPro game client in a real, logged-in browser session and records the canvas via `MediaRecorder`. Produces game-accurate video with the real map art, UI, and effects. Stitches clips together with cross-dissolve transitions and appends a generated scoreboard summary card. |
| **Custom canvas renderer** (original prototype) | `src/index.js` → `src/render-clips.js` | Re-implements a minimal TagPro renderer from scratch in an HTML canvas and drives it headlessly with Playwright. No login required, but the map/tile art is currently placeholder colored shapes, not real sprites (see [Known Issues](#known-issues--todo)). |
| **VGS voice-line overlay demo** (experimental) | `src/render-vgs-demo.js`, `src/render-vgs-overlay.js` | Burns scripted "Voice Game Sounds" chat/menu overlays and macOS-generated TTS audio onto a clip. Built for demoing an in-game comms feature concept; not part of the core highlight pipeline. |

## How it works (pipeline overview)

1. **Parse** — `src/parse-replay.js` reads a TagPro NDJSON replay (one JSON event per line: player deltas, map state, score, game clock) and reconstructs cumulative player/game state.
2. **Score & cluster** — `src/score-highlights.js` scores notable events (captures, returns, multi-tags, etc.) and clusters them into a handful of ~20–24s highlight windows.
3. **Export a manifest** — `src/export-manifest.js` writes `highlight-manifest.json` describing each clip (start/end time, players involved, description).
4. **Render** — either:
   - `src/export-replay-clips.js` replays the game inside the real TagPro client (via an authenticated session) and screen-records each clip with `MediaRecorder`, or
   - `src/build-frame-data.js` + `src/render-clips.js` build per-frame JSON and drive the custom canvas renderer in `src/renderer/index.html`.
5. **Stitch** — clips are concatenated with `ffmpeg` cross-dissolve transitions into a single highlight reel, with an optional generated scoreboard summary card at the end.

## Requirements

> **Platform: macOS only, currently.** Several pieces shell out to macOS-specific tools (`say` for text-to-speech, `security`/`openssl` for reading the macOS Keychain, `open` for launching Chrome). Porting to Linux/Windows would mean replacing these — see [Known Issues](#known-issues--todo).

- **Node.js 18+** (uses ESM `import`, top-level `await`)
- **Google Chrome**, installed and logged in at `tagpro.koalabeast.com` — only needed for the real-renderer pipeline (`export-replay-clips.js`), which authenticates by reading your existing TagPro session cookie out of Chrome's local cookie database (see [Authentication](#authentication--the---login-flow) below)
- **[ffmpeg](https://ffmpeg.org/) and `ffprobe`** on your `PATH` (`brew install ffmpeg`) — used for clip stitching, transitions, and audio muxing
- **Python 3** — used for two small helper scripts:
  - `src/extract_chrome_cookies.py` — stdlib only, no install needed
  - `src/gen_vgs_overlays.py` and the inline scoreboard-card renderer in `export-replay-clips.js` — need [Pillow](https://pillow.readthedocs.io/): `pip3 install pillow`
- **npm dependencies** (see `package.json`):
  - [`playwright`](https://playwright.dev/) — headless/headed Chromium automation
  - [`node-fetch`](https://github.com/node-fetch/node-fetch) — HTTP client for the `tagpro.eu`/`--match` lookup flow

## Install

```bash
git clone <this-repo-url>
cd tagpro-highlights

npm install
npx playwright install chromium   # downloads the Chromium browser Playwright drives

brew install ffmpeg               # if you don't already have it
pip3 install pillow               # for overlay/summary-card image generation
```

## Getting a replay file

You need a TagPro replay in NDJSON format (one JSON array per line: `[timestampMs, eventType, data]`). There are two ways to get one:

1. **Automatically**, via `--match=<tagpro.eu match ID>` (see below) — looks up the match on `tagpro.eu`, resolves it to a `tagpro.koalabeast.com` game ID, and downloads the NDJSON directly.
2. **Manually** — save a replay's NDJSON file yourself and pass its path as the first positional argument to any script.

## Usage

### Real-renderer export (recommended)

```bash
node src/export-replay-clips.js [ndjsonPath] [flags]
```

| Flag | Description |
|---|---|
| `[ndjsonPath]` (positional) | Path to a local NDJSON replay file. Ignored if `--match` is set. Defaults to a sample path under `~/Downloads` if omitted. |
| `--match=<id>` | A `tagpro.eu` match ID. Looks up the match's UUID, resolves the corresponding replay on `tagpro.koalabeast.com`, and downloads the NDJSON automatically — no manual file needed. |
| `--replay=<key>` | Explicitly overrides the replay key used to build the `tagpro.koalabeast.com/game?replay=...` URL, instead of deriving it automatically or from `--match`. |
| `--clips=<n>` | Max number of non-capture "filler" highlight clips to include (default: `10`). Flag captures are always kept. |
| `--caps-only` | Only export clips centered on flag captures. |
| `--debug-clip` | Record only the first clip, starting at t=0 — useful for debugging POV/timing issues without rendering the whole set. |
| `--login` | Opens Chrome to `tagpro.koalabeast.com/login` so you can sign in, then waits for Enter before continuing. Use this the first time, or whenever your session has expired. |

Output: `output/clips/clip_01.mp4 …` and a stitched `output/game-summary.mp4`.

#### Authentication / the `--login` flow

`export-replay-clips.js` needs to load a replay on the real `tagpro.koalabeast.com` client, which requires being logged in. Rather than juggling a separate Playwright-managed login, it reads your **existing** Chrome session cookie for `tagpro.koalabeast.com` straight out of Chrome's local, on-disk cookie database and injects it into Playwright's browser context.

- Cookie decryption uses your macOS Keychain entry for "Chrome Safe Storage" (via the `security` CLI) plus `openssl`, exactly the way Chrome itself does it — nothing leaves your machine.
- Run with `--login` the first time (or after your session expires) to open a real Chrome window, sign in normally, and press Enter to continue.
- This only ever reads *your own* local, already-logged-in browser profile. It does not transmit or persist credentials anywhere. See `src/extract_chrome_cookies.py` for the full implementation.

### Custom canvas renderer (original prototype)

```bash
node src/index.js [ndjsonPath]                                   # parse + score → highlight-manifest.json
node src/render-clips.js [ndjsonPath] [manifestPath] [clipIndex]  # render clip(s) with the custom canvas renderer
```

| Argument (positional) | Description |
|---|---|
| `ndjsonPath` | Path to the NDJSON replay (both scripts). |
| `manifestPath` (`render-clips.js` only) | Path to the highlight manifest JSON. Defaults to `./highlight-manifest.json`. |
| `clipIndex` (`render-clips.js` only) | Render a single clip by index instead of all clips. |

Output: `output/clips/clip-NN.webm`, `output/frame-data/clip-N.json`.

### VGS voice-line overlay demo (experimental)

```bash
node src/generate-audio.js                                        # generate WAV voice lines via macOS `say`
node src/render-vgs-demo.js [replayPath] [clipIndex] [triggerMs] [voicePack]
node src/render-vgs-overlay.js [inputVideoPath]                    # burn overlays onto an existing recording
python3 src/gen_vgs_overlays.py [width] [height] [outDir]          # (called automatically as needed)
```

| Argument | Applies to | Description |
|---|---|---|
| `replayPath` (positional) | `render-vgs-demo.js` | NDJSON replay path. Defaults to a sample path under `~/Downloads`. |
| `clipIndex` (positional) | `render-vgs-demo.js` | Which highlight clip to demo (default: `3`). |
| `triggerMs` (positional) | `render-vgs-demo.js` | When the overlay/voice line fires, in ms (default: `3000`). |
| `voicePack` (positional) | `render-vgs-demo.js` | Voice pack name (default: `alex`). |
| `inputVideoPath` (positional) | `render-vgs-overlay.js` | Source video to overlay onto. Defaults to `~/Downloads/CAPS.mov`. |

This tool is macOS-only end-to-end: `generate-audio.js` shells out to the built-in `say` command for text-to-speech.

## Key files

| File | Purpose |
|---|---|
| `src/parse-replay.js` | Parses NDJSON, delta-tracks player stats to detect events |
| `src/score-highlights.js` | Scores events, clusters them into highlight clips |
| `src/export-manifest.js` | Writes `highlight-manifest.json` |
| `src/build-frame-data.js` | Builds 30fps frame data JSON per clip (custom-renderer pipeline) |
| `src/build-timeline.js`, `src/decode-events.js`, `src/bit-reader.js` | Lower-level replay decoding helpers |
| `src/renderer/index.html` | Custom canvas renderer (loaded by Playwright, driven by `render-clips.js`) |
| `src/renderer/vgs.html` | Renderer used by the VGS overlay demo |
| `src/renderer/tiles.png` | TagPro tile spritesheet (640×720, 16×11 grid at 40px/tile) — not yet wired up, see below |
| `src/export-replay-clips.js` | Main real-renderer export pipeline (auth, record, stitch, summary card) |
| `src/extract_chrome_cookies.py` | Reads/decrypts your local Chrome session cookie for TagPro auth |
| `src/fetch-match.js` | Fetches match metadata from `tagpro.eu` |
| `output/clips/` | Rendered clip videos |
| `output/frame-data/` | Frame data JSON (custom-renderer pipeline, regenerated per run) |
| `highlight-manifest.json` | Highlight clip manifest for the sample test replay |

## Known Issues / TODO

### Custom canvas renderer
- **No real tile sprites** — walls/floor/flags currently render as flat colored shapes rather than the actual sprites in `src/renderer/tiles.png`. Mapping each tile ID to its pixel position in the 16×11 spritesheet is an open task. This is one reason the real-renderer pipeline (`export-replay-clips.js`) is now the primary path.
- **No `mapupdate` tracking in frame data** — flag-taken state, gate open/close, and bomb state changes aren't reflected per-frame; tiles are static from the initial `map` event.
- **Diagonal wall variants** — only 4 basic orientations are handled; some sub-variants fall through to a solid square.

### Pipeline / output quality
- **Game clock is clip-relative** — clips show elapsed time from clip start rather than the actual in-game clock.
- **No AI-generated captions** — event descriptions are currently rule-based; could be enhanced with an LLM.
- **Frame data JSON can be large** for long games — worth compressing.

### Platform
- **macOS-only** — `say` (TTS), Keychain-based cookie decryption (`security`/`openssl`), and `open` all assume macOS. Contributions to support Linux/Windows (e.g. swapping TTS providers, a cross-platform cookie extraction path) are welcome.

## License

[MIT](LICENSE)

## Before publishing this repo

One remaining housekeeping item worth doing before making this public:
- Scripts default to sample file paths containing a personal TagPro username (`billdacat`) and a specific replay ID — harmless, but worth genericizing (e.g. `./sample.ndjson`) for a public template.
