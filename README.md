# TagPro Highlights

Turn a [TagPro](https://tagpro.gg) replay into short, shareable highlight clips — flag captures, big returns, and other key moments — automatically detected from the game's raw replay data. Point it at an [MLTP](https://www.mltp.gg) matchup and it exports every game of the series into one highlight reel.

The project has two independent rendering pipelines plus one experimental side tool:

| Pipeline | Entry point | What it does |
|---|---|---|
| **Real-renderer export** (recommended) | `src/export-replay-clips.js` | Drives the actual TagPro game client in a real, logged-in browser session and records the canvas via `MediaRecorder`. Produces game-accurate video with the real map art, UI, and effects. Stitches clips together with cross-dissolve transitions and appends a generated scoreboard summary card. |
| **Custom canvas renderer** (original prototype) | `src/index.js` → `src/render-clips.js` | Re-implements a minimal TagPro renderer from scratch in an HTML canvas and drives it headlessly with Playwright. No login required, but the map/tile art is currently placeholder colored shapes, not real sprites (see [Known Issues](#known-issues--todo)). |
| **VGS voice-line overlay demo** (experimental) | `src/render-vgs-demo.js`, `src/render-vgs-overlay.js` | Burns scripted "Voice Game Sounds" chat/menu overlays and macOS-generated TTS audio onto a clip. Built for demoing an in-game comms feature concept; not part of the core highlight pipeline. |

## How it works (pipeline overview)

1. **Parse** — `src/parse-replay.js` reads a TagPro NDJSON replay (one JSON event per line: player deltas, map state, score, game clock) and reconstructs cumulative player/game state.
2. **Score & cluster** — `src/score-highlights.js` builds a clip window around every capture (8 s of build-up, 1 s after the score; captures close together share one clip) and around every other notable play: returns, rated by what they stopped (a quick return on a fresh grab, or ending a long carry), and long carries that never scored. Each clip gets a camera schedule: a clip with several captures follows each capper in turn; any other clip follows the player who made the play.
3. **Export a manifest** — `src/export-manifest.js` writes `highlight-manifest.json` describing each clip (start/end time, players involved, description).
4. **Render** — either:
   - `src/export-replay-clips.js` replays the game inside the real TagPro client (via an authenticated session) and screen-records each clip with `MediaRecorder`, or
   - `src/build-frame-data.js` + `src/render-clips.js` build per-frame JSON and drive the custom canvas renderer in `src/renderer/index.html`.
5. **Stitch** — each clip gets a lower-third caption (`src/captions.js`), then clips are hard-cut together with `ffmpeg`, with a short dip to black around the generated cards (crossfade/dissolve joins are available via `--transition`), and a scoreboard summary card closes the reel.
6. **Series reels** (multi-game) — `src/mltp.js` resolves an mltp.gg matchup to its tagpro.eu match IDs; every game is recorded in turn, clips from all games are ranked against one duration budget, and the per-game reels are joined with generated series intro, per-game title, and series final cards (`src/series-cards.js`).

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
2. **From an MLTP matchup**, via `--mltp=<matchup ID or URL>` — reads the matchup page on mltp.gg, pulls the tagpro.eu match ID of every game in the series, and does step 1 for each of them.
3. **Manually** — save a replay's NDJSON file yourself and pass its path as the first positional argument to any script.

Note that replays only stay on `tagpro.koalabeast.com` for a limited time; a game whose replay has expired is skipped with a warning when exporting a series.

Replay files are requested the same way TagPro's own replay viewer requests them (`/replays/gameFile?key=<replay key>`). Which replays the server hands out without a login varies from game to game and changes over time, so when a request is refused the exporter retries with your TagPro login from Chrome (see [Authentication](#authentication--the---login-flow)). If no Chrome profile is logged into TagPro the game is skipped, and the fix is to log into tagpro.koalabeast.com in Chrome and rerun. A replay that has been fetched once is kept and reused.

## Usage

### Real-renderer export (recommended)

```bash
node src/export-replay-clips.js [ndjsonPath] [flags]
```

| Flag | Description |
|---|---|
| `[ndjsonPath]` (positional) | Path to a local NDJSON replay file. Ignored if `--match` is set. Defaults to a sample path under `~/Downloads` if omitted. |
| `--match=<id>[,<id>…]` | One or more `tagpro.eu` match IDs (comma-separated, or repeat the flag). Each is looked up on `tagpro.eu`, resolved to its replay on `tagpro.koalabeast.com`, and the NDJSON downloaded automatically. More than one ID produces a multi-game series reel. |
| `--mltp=<id or URL>` | An mltp.gg matchup ID or URL, e.g. `https://www.mltp.gg/matchup/<uuid>?tier=majors` (copy it from the [schedule](https://www.mltp.gg/schedule?tier=majors)). Pulls the tagpro.eu match ID of every game in the series and exports them all into one reel, in game order. A game whose replay cannot be fetched is skipped with a warning, and the reel is correspondingly shorter. |
| `--minutes=<m>` | Target reel length (default: `8`). Every capture is always included, even when captures alone run past the target. If they leave room, the best other plays (quick returns, big returns, long carries that didn't score) fill the reel up to the target. `--max-minutes` is accepted as the old name. |
| `--chrome-profile=<name>` | Pin the Chrome profile to read the TagPro login from, e.g. `Profile 4`. By default every profile is checked and the one with a live TagPro session is used. |
| `--dry-run` | Resolve the games, score the highlights, print the reel plan and estimated length, then stop before opening the browser. Handy for checking what a series reel will contain. |
| `--restitch` | Skip recording. Reloads the `plan.json` each run saves next to its clips and rebuilds captions, cards, and the reel from the existing clip files. Use it to iterate on the look without another real-time recording pass. |
| `--transition=<t>` | How clips are joined. `cut` (default): hard cuts between plays, a 0.5 s dip to black wherever a card meets anything. `fade`: 1.5 s crossfade between everything. `dissolve`: the same with ffmpeg's noisy pixel dissolve. In the blend modes each clip starts on the previous clip's focal player and switches POV mid-blend to hide the camera jump. |
| `--no-captions` | Skip the lower-third caption (event type, player, team) burned onto the opening seconds of each clip. |
| `--logo=<team>=<file>` | With `--mltp`: use `<file>` as that team's logo for this run only. `<team>` is an abbreviation or part of the team name. Repeatable. Nothing is saved, so the next run goes back to the team's real logo. |
| `--replay=<key>` | Explicitly overrides the replay key used to build the `tagpro.koalabeast.com/game?replay=...` URL, instead of deriving it automatically or from `--match`. Single-game only. |
| `--clips=<n>` | Max number of non-capture plays to consider per game (default: `30`). Captures are always kept. |
| `--caps-only` | Only export clips centered on flag captures. |
| `--debug-clip` | Record only the first clip, starting at t=0 — useful for debugging POV/timing issues without rendering the whole set. |
| `--login` | Opens Chrome to `tagpro.koalabeast.com/login` so you can sign in, then waits for Enter before continuing. Use this the first time, or whenever your session has expired. |

Output for a single game: `output/clips/clip_01.mp4 …` and a stitched `output/game-summary.mp4` (intro, highlights, team comparison card, box score).

#### End-of-game scoreboards

Every game closes on a **team comparison** card: the final score, each team's name and roster, and eight labelled stat bars (caps, grabs, hold, returns, tags, prevent, powerups, pops) with the better side lit. Single-game reels follow it with a **box score**: one row per player, with the best value in each column in gold. A player who reconnects mid-game appears once, with their stats added up.

To look at the cards for a replay without recording anything:

```bash
node src/preview-scoreboards.js <replay.ndjson> [--mltp=<matchup> --game=N] [--out=DIR]
```

#### Series reels (MLTP matchups or several match IDs)

```bash
node src/export-replay-clips.js --mltp=https://www.mltp.gg/matchup/e8a207df-74b2-46b1-919b-2c496dff9aeb?tier=majors
node src/export-replay-clips.js --mltp=e8a207df-74b2-46b1-919b-2c496dff9aeb --max-minutes=6 --dry-run
node src/export-replay-clips.js --match=4389828,4389843,4389859
```

Each game is recorded in its own tab of the same logged-in browser, then the reel is assembled as: series intro card → for each game, a title card (map, series score so far, which colour each team plays), that game's captioned highlight clips hard-cut together, and its recap card → series final card with every game's score. Cards are separated from gameplay by a short dip to black. Team names and colours come from mltp.gg when available; with plain `--match` IDs they come from the replay's red/blue team names.

With `--mltp`, both teams' logos are downloaded from the matchup page into `output/logos/` and shown on the series cards. Logos are used as uploaded: a transparent logo is trimmed and shown as it is, an opaque square one is shown as a rounded tile. A team colour that is close to black is lifted to a light neutral so the name stays readable on the dark cards.

Output:

```
output/match/game_01/clips/           title, clip_NN (+ .captioned), recap (and intro, recorded for sprite warm-up)
output/match/game_01/plan.json        the clips that were recorded, for --restitch
output/match/game_01/game-summary.mp4 that game's section of the reel
output/match/cards/                   series-intro, series-final
output/match-highlights.mp4           the full series reel
```

Recording happens in real time, so a series reel with an 8-minute budget takes roughly 15–20 minutes to export.

#### Camera and timing

The recorder is timed off the replay's own clock (the seek bar's position in milliseconds), not wall-clock timers. It seeks slightly before the clip, lets playback run up to the clip's start, and captures exactly the planned window, so a capture lands where the plan says it does.

When a clip contains two captures by different players, the camera stays on the first capper until a second after their cap, then glides to the next capper using TagPro's own eased camera pan. Each camera stop gets its own lower-third caption, shown when the camera arrives. Captures that are far enough apart are simply separate clips.

#### Authentication / the `--login` flow

`export-replay-clips.js` needs to load a replay on the real `tagpro.koalabeast.com` client, and the server hands some replays only to logged-in users. Rather than juggling a separate Playwright-managed login, it reads your **existing** TagPro login straight out of Chrome's local, on-disk cookie database and injects it into Playwright's browser context. TagPro's session cookie lives on the parent domain `.koalabeast.com` (so it also covers the game servers), so the whole domain's cookies are read. Without `--chrome-profile`, every Chrome profile is checked and the one holding a live TagPro session is used; the run log says which.

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
| `src/export-replay-clips.js` | Main real-renderer export pipeline (auth, record, stitch, summary card, series reels) |
| `src/mltp.js` | Resolves an mltp.gg matchup to its games and tagpro.eu match IDs |
| `src/series-cards.js`, `src/series_cards.py` | Series intro, per-game title, series final cards, and the caption badge renderer |
| `src/captions.js` | Builds each clip's lower-third caption and burns it in with ffmpeg |
| `src/scoreboard-cards.js`, `src/scoreboard_cards.py` | End-of-game team comparison and box score cards |
| `src/card_logos.py` | Team logo handling shared by the card renderers |
| `src/preview-scoreboards.js` | Renders the scoreboard cards for a replay without recording |
| `src/extract_chrome_cookies.py` | Reads/decrypts your local Chrome session cookie for TagPro auth |
| `src/fetch-match.js` | Fetches match metadata from `tagpro.eu` |
| `output/clips/` | Rendered clip videos (single game); series runs use `output/match/` |
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
