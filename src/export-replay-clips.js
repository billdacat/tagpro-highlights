// Export TagPro replay highlight clips using the real TagPro rendering engine.
//
// Usage:
//   node src/export-replay-clips.js [ndjsonPath] [--match=EU_ID[,EU_ID...]] [--mltp=MATCHUP] [flags]
//
// --match=ID[,ID..]  tagpro.eu match ID(s) — looks up UUID, downloads NDJSON, derives replay key.
//                    Several IDs (comma-separated or repeated) are exported as one series reel.
// --mltp=ID|URL      mltp.gg matchup ID or URL — pulls the tagpro.eu match ID of every game in
//                    the series and exports them all into one reel.
// --replay=KEY       Override the replay key (single game only; raw, not URL-encoded)
// --caps-only        Only export clips centered on flag captures
// --clips=N          Max filler (non-cap) clips considered per game (default: 30)
// --minutes=M        Target reel length (default: 8).  Every cap is always included, even
//                    if caps alone run past the target; other plays (quick returns, big
//                    returns, long carries) fill the reel up to the target.
// --chrome-profile=P Chrome profile to read the TagPro login from (default: Default).
// --dry-run          Resolve games, score highlights, print the reel plan, then stop.
// --restitch         Skip recording; rebuild cards/captions/reel from the clips of the last run.
// --transition=T     cut (default: hard cuts, dip-to-black at cards) | fade | dissolve
// --no-captions      Skip the lower-third caption burned onto each clip.
// --logo=TEAM=FILE   With --mltp: use FILE as TEAM's logo for this run only (TEAM is an
//                    abbreviation or part of the team name).  Repeatable.
// --login            Open Chrome so you can log into TagPro, then extract session cookies
//
// Output (single game): output/clips/clip_01.mp4 ... output/game-summary.mp4
// Output (multi game) : output/match/game_NN/... output/match-highlights.mp4

import { chromium, request as playwrightRequest } from 'playwright';
import { mkdirSync, createWriteStream, readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync, execSync } from 'child_process';
import { get as httpsGet } from 'https';
import { parseReplay }    from './parse-replay.js';
import { scoreHighlights } from './score-highlights.js';
import { fetchMatchup, describeMatchup, downloadTeamLogos, applyLogoOverrides } from './mltp.js';
import { makeSeriesIntroCard, makeGameTitleCard, makeSeriesFinalCard, CARD_SECONDS,
         seriesScoreAfter, seriesScoreEntering } from './series-cards.js';
import { captionsFor, renderCaptionPng, burnCaptions } from './captions.js';
import { buildScoreboardData, makeCompareCard, makeBoxScoreCard } from './scoreboard-cards.js';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Args ───────────────────────────────────────────────────────────────────
const LOGIN_MODE = process.argv.includes('--login');
const flag       = name => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
// All values of a repeatable flag, also split on commas: --match=1,2 --match=3 → ['1','2','3']
const flags      = name => process.argv
  .filter(a => a.startsWith(`--${name}=`))
  .flatMap(a => a.split('=').slice(1).join('=').split(','))
  .map(v => v.trim()).filter(Boolean);
const positional = process.argv.filter(a => !a.startsWith('--'));

const MATCH_IDS  = flags('match');
const MLTP       = flag('mltp');
const CAPS_ONLY  = process.argv.includes('--caps-only');
const MAX_CLIPS  = parseInt(flag('clips') ?? positional[4] ?? '30');
const DEFAULT_TARGET_MINUTES = 8;
// --minutes is the target length.  --max-minutes is accepted as the old name for it.
const TARGET_MINUTES = parseFloat(flag('minutes') ?? flag('max-minutes') ?? String(DEFAULT_TARGET_MINUTES));
if (flag('max-minutes') != null && flag('minutes') == null)
  console.warn('note: --max-minutes now means the target length (caps are never cut); use --minutes');
const CHROME_PROFILE = flag('chrome-profile') ?? null;
const DRY_RUN    = process.argv.includes('--dry-run');
const RESTITCH   = process.argv.includes('--restitch');
const TRANSITION = flag('transition') ?? 'cut';        // cut | fade | dissolve
const CAPTIONS   = !process.argv.includes('--no-captions');
// --logo=TEAM=FILE (repeatable): a one-off logo for this run; nothing is saved.
const LOGO_OVERRIDES = process.argv.filter(a => a.startsWith('--logo=')).map(a => {
  const [team, ...rest] = a.slice('--logo='.length).split('=');
  const path = resolve(rest.join('='));
  if (!team || !rest.length) throw new Error(`--logo expects TEAM=FILE (got "${a}")`);
  if (!existsSync(path))     throw new Error(`--logo: file not found: ${path}`);
  return { team, path };
});
// --debug-clip: record only clip 1, starting from t=0, so you can watch the
// full game start and see exactly where the focal player appears/disappears.
const DEBUG_CLIP = process.argv.includes('--debug-clip');
if (!(TARGET_MINUTES > 0)) throw new Error('--minutes must be a positive number');
if (!['cut', 'fade', 'dissolve'].includes(TRANSITION)) throw new Error(`--transition must be cut, fade or dissolve (got "${TRANSITION}")`);

const DISSOLVE_SEC  = 1.5;  // overlap per join in the fade/dissolve modes
const CARD_FADE_SEC = 0.5;  // dip-to-black at card boundaries in cut mode
const INTRO_SEC     = 4;    // gameplay cold-open recorded at the flags-live moment
const RECAP_SEC     = 7;    // team comparison card that closes each game
const SCOREBOARD_SEC = 8;   // full box-score card (single-game reels only)

// ── Helpers ────────────────────────────────────────────────────────────────

function getVideoDurationSec(filePath) {
  const out = execFileSync('ffprobe', [
    '-v', 'quiet', '-print_format', 'json',
    '-show_streams', '-select_streams', 'v:0',
    filePath,
  ], { encoding: 'utf8' });
  const stream = JSON.parse(out).streams[0];
  return parseFloat(stream.duration);
}

// Stitch clips together with a cross-blend (xfade `fade` or `dissolve`) between
// each pair.  Uses chained ffmpeg xfade filters — no intermediate transition files needed.
function stitchWithDissolve(clipPaths, outputPath, dissolveSec = DISSOLVE_SEC, transition = 'dissolve') {
  if (clipPaths.length === 1) {
    execFileSync('ffmpeg', [
      '-y', '-i', clipPaths[0],
      '-vf', 'fps=30,setpts=PTS-STARTPTS',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-an', outputPath,
    ]);
    return;
  }

  const durations = clipPaths.map(getVideoDurationSec);
  const inputs    = clipPaths.flatMap(p => ['-i', p]);
  const filters   = [];

  // Normalise each clip to 30 fps with PTS reset
  clipPaths.forEach((_, i) => {
    filters.push(`[${i}:v]fps=30,setpts=PTS-STARTPTS[nv${i}]`);
  });

  // Chain xfades: offset accumulates as (sum of prior clip durations) - (dissolves consumed so far)
  let prevLabel  = '[nv0]';
  let cumOffset  = 0;

  for (let i = 1; i < clipPaths.length; i++) {
    cumOffset += durations[i - 1] - dissolveSec;
    const isLast   = i === clipPaths.length - 1;
    const outLabel = isLast ? 'vout' : `xf${i}`;
    filters.push(
      `${prevLabel}[nv${i}]xfade=transition=${transition}:duration=${dissolveSec}:offset=${cumOffset.toFixed(4)}[${outLabel}]`
    );
    prevLabel = `[${outLabel}]`;
  }

  console.log(`  Stitching ${clipPaths.length} clips with ${dissolveSec}s ${transition}s...`);
  execFileSync('ffmpeg', [
    '-y',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-an',
    outputPath,
  ]);
}

// Hard cuts between gameplay clips; a short dip to black wherever a card meets
// anything else.  `segments` is [{ path, kind: 'clip' | 'card' }].  Runs of
// consecutive clips are concatenated into one node, then nodes are joined with
// xfade=fadeblack.
function stitchCuts(segments, outputPath, fadeSec = CARD_FADE_SEC) {
  const inputs  = segments.flatMap(s => ['-i', s.path]);
  const durs    = segments.map(s => getVideoDurationSec(s.path));
  // settb: concat emits microsecond timestamps while fps= emits 1/30, and xfade refuses
  // to join inputs whose timebases differ, so every node is pinned to AV_TIME_BASE.
  const filters = segments.map((_, i) => `[${i}:v]fps=30,scale=1280:720,setpts=PTS-STARTPTS,settb=AVTB[n${i}]`);

  const nodes = [];
  segments.forEach((s, i) => {
    const last = nodes[nodes.length - 1];
    if (s.kind === 'clip' && last?.kind === 'clip') { last.idx.push(i); last.dur += durs[i]; }
    else nodes.push({ kind: s.kind, idx: [i], dur: durs[i] });
  });
  nodes.forEach((n, k) => {
    n.label = n.idx.length === 1 ? `n${n.idx[0]}` : `run${k}`;
    if (n.idx.length > 1)
      filters.push(`${n.idx.map(i => `[n${i}]`).join('')}concat=n=${n.idx.length}:v=1:a=0,settb=AVTB[${n.label}]`);
  });

  let prev = nodes[0].label, offset = 0;
  for (let k = 1; k < nodes.length; k++) {
    offset += nodes[k - 1].dur - fadeSec;
    const out = k === nodes.length - 1 ? 'vout' : `x${k}`;
    filters.push(`[${prev}][${nodes[k].label}]xfade=transition=fadeblack:duration=${fadeSec}:offset=${offset.toFixed(4)}[${out}]`);
    prev = out;
  }

  const clips = segments.filter(s => s.kind === 'clip').length;
  console.log(`  Stitching ${segments.length} segments: ${clips} hard-cut clip(s), ${nodes.length - 1} ${fadeSec}s dip(s) to black...`);
  execFileSync('ffmpeg', [
    '-y', ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', `[${prev}]`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-an', outputPath,
  ]);
}

function stitch(segments, outputPath) {
  if (TRANSITION === 'cut') stitchCuts(segments, outputPath, CARD_FADE_SEC);
  else stitchWithDissolve(segments.map(s => s.path), outputPath, DISSOLVE_SEC, TRANSITION);
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    httpsGet(url, { headers: { Accept: 'application/json' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error from ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

// TagPro's own hexToBase64: converts hex → binary → base64, then + → _ (NOT standard URL-safe)
function hexToBase64(hexStr) {
  return Buffer.from(hexStr, 'hex').toString('base64').replaceAll('+', '_');
}

async function deriveReplayKey(meta) {
  const uuid = meta?.uuid;
  if (!uuid) throw new Error('No UUID in NDJSON recorder-metadata');

  const data = await fetchJSON(
    `https://tagpro.koalabeast.com/replays/data?uuid=${encodeURIComponent(uuid)}`
  );
  const game = data?.games?.[0];
  if (!game?.id) throw new Error(`No replay found for UUID ${uuid}`);

  // Get recorder's userId from NDJSON metadata
  const followPlayerId  = meta.follow?.[0];
  const recorderUserId  = followPlayerId != null
    ? (meta.players?.find(p => p.id === followPlayerId)?.userId ?? '')
    : '';

  const hexStr = game.id + recorderUserId;
  console.log(`  game.id: ${game.id}  userId: ${recorderUserId || '(none)'}`);
  return hexToBase64(hexStr);
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);
    const fail = err => { file.close(); try { unlinkSync(destPath); } catch {} reject(err); };
    httpsGet(url, res => {
      if (res.statusCode !== 200) { fail(new Error(`HTTP ${res.statusCode} downloading ${url}`)); return; }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
      file.on('error', fail);
    }).on('error', fail);
  });
}

// TagPro session cookies, read once from Chrome's profile (see extract_chrome_cookies.py).
// Instead of trying to launch Chrome with a debug port (blocked by macOS's singleton
// mechanism), we read the cookies from Chrome's profile database and hand them to
// Playwright.
let tagproCookiesCache = null;
function getTagproCookies() {
  if (tagproCookiesCache) return tagproCookiesCache;
  console.log('  Reading TagPro cookies from Chrome profile...');
  tagproCookiesCache = [];
  try {
    const args   = [resolve(__dir, 'extract_chrome_cookies.py'), ...(CHROME_PROFILE ? [CHROME_PROFILE] : [])];
    const raw    = execFileSync('python3', args, { encoding: 'utf8' });
    const parsed = JSON.parse(raw);
    if (parsed.error) {
      console.error(`  Cookie extraction warning: ${parsed.error}`);
    } else {
      tagproCookiesCache = parsed.cookies;
      console.log(`  Found ${tagproCookiesCache.length} cookie(s) for tagpro.koalabeast.com`);
    }
  } catch (err) {
    console.error(`  Cookie extractor failed: ${err.message}`);
  }
  return tagproCookiesCache;
}

// Some replay files are only served to logged-in users.  Fetch with the same TagPro
// session the recording browser uses.  Redirects are not followed, so the session
// cookie is only ever sent to the host in `url`.
async function downloadFileWithSession(url, destPath) {
  const cookies = getTagproCookies();
  if (!cookies.length) throw new Error('this replay needs a TagPro login and no session cookies were found — run with --login');
  const api = await playwrightRequest.newContext({
    extraHTTPHeaders: { Cookie: cookies.map(c => `${c.name}=${c.value}`).join('; ') },
  });
  try {
    const res = await api.get(url, { maxRedirects: 0 });
    if (!res.ok()) {
      const why = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 160);
      if (/logged in/i.test(why)) {
        throw new Error(`this replay is only served to logged-in users, and the Chrome profile the exporter reads ` +
          `("${CHROME_PROFILE ?? 'Default'}") has no active TagPro login. Log into tagpro.koalabeast.com in Chrome, ` +
          `then rerun; if you use another Chrome profile, pass --chrome-profile=<name>`);
      }
      throw new Error(`HTTP ${res.status()} downloading ${url}${why ? ` — server says: "${why}"` : ''}`);
    }
    writeFileSync(destPath, await res.body());
  } finally {
    await api.dispose();
  }
  return destPath;
}

// Resolves a tagpro.eu match ID → { ndjsonPath, replayKey }
// Downloads the NDJSON directly from TagPro's server (no local recording needed).
async function lookupMatch(matchId) {
  console.log(`  Fetching match ${matchId} from tagpro.eu...`);
  const euData = await fetchJSON(`https://tagpro.eu/data/?match=${encodeURIComponent(matchId)}`);
  const uuid = euData?.uuid;
  if (!uuid) throw new Error(`tagpro.eu returned no UUID for match ${matchId}`);
  console.log(`  UUID: ${uuid}`);

  const replayData = await fetchJSON(
    `https://tagpro.koalabeast.com/replays/data?uuid=${encodeURIComponent(uuid)}`
  );
  const game = replayData?.games?.[0];
  if (!game?.id) throw new Error(`No replay data found for UUID ${uuid}`);
  console.log(`  game.id: ${game.id}`);

  // Ask for the file the way TagPro's own replay viewer does: by replay key.  The
  // gameId form of this endpoint is refused for some games that the key form serves
  // to anyone, so it is only the second choice.  A login is the last resort.
  const replayKey  = hexToBase64(game.id);
  const base       = 'https://tagpro.koalabeast.com/replays/gameFile';
  const urls       = [`${base}?key=${encodeURIComponent(replayKey)}`, `${base}?gameId=${game.id}`];
  const ndjsonPath = `/tmp/tagpro-match-${matchId}.ndjson`;
  // A replay never changes once the game is over, so a copy fetched earlier is reused.
  // That also keeps a matchup exportable after the server starts asking for a login.
  if (existsSync(ndjsonPath) && statSync(ndjsonPath).size > 50_000) {
    console.log(`  Using the replay fetched earlier: ${ndjsonPath}`);
    return { ndjsonPath, replayKey };
  }
  console.log(`  Downloading NDJSON...`);
  let lastErr;
  for (const url of urls) {
    try { await downloadFile(url, ndjsonPath); lastErr = null; break; }
    catch (err) { lastErr = err; }
  }
  if (lastErr) {
    if (!/HTTP 40[13]\b/.test(lastErr.message)) throw lastErr;
    console.log('  Replay file was refused without a login; retrying with your TagPro session...');
    await downloadFileWithSession(urls[0], ndjsonPath);
  }

  return { ndjsonPath, replayKey };
}

// ── In-page recording function ─────────────────────────────────────────────
// Everything is timed off the replay's own clock (the seek bar's value, in ms)
// rather than wall-clock timers: seek a little before the clip, let playback run
// up to sliderMs, start capturing exactly there, stop at sliderMs + durationMs.
//
// pov is [{ atMs, name, pan }].  The first entry is applied before capture starts.
// Later entries fire when the replay reaches sliderMs + atMs; with pan they use
// TagPro's own eased camera move, so the next capper is brought to centre smoothly.
const RECORDER_SRC = String.raw`
window.__tpRecord = (sliderMs, durationMs, targetW, targetH, bitrateMbps, pov) =>
  new Promise((resolve, reject) => {
    const log = m => console.log('[tp-export] ' + m);
    const rp  = window.tagpro?.replayPlayer;
    const bar = document.getElementById('replaySeekBar');
    if (!rp)  { reject('tagpro.replayPlayer not found'); return; }
    if (!bar) { reject('#replaySeekBar not found'); return; }
    const now = () => parseInt(bar.value, 10) || 0;

    // Playback keeps running through the seek guard and POV set-up, so land early.
    const PREROLL_MS = 1200;
    const seekTo = Math.max(0, sliderMs - PREROLL_MS);
    rp.seek(seekTo);
    log('seeking to ' + seekTo + 'ms (clip starts at ' + sliderMs + 'ms)');

    const seekStart = Date.now();
    // 200 ms guard: on the first seek rp.seeking can flip false before our poll tick
    setTimeout(() => {
      const waitForSeek = () => {
        if (!rp.seeking)                           { onSeekComplete(); }
        else if (Date.now() - seekStart > 8000)    { reject('seek timed out'); }
        else                                       { setTimeout(waitForSeek, 50); }
      };
      waitForSeek();
    }, 200);

    // A player who rejoined has two entries under one name; the newest id is the live one.
    const idOf = name => {
      const ids = Object.entries(tagpro.players || {})
        .filter(([, p]) => p.name === name).map(([id]) => parseInt(id));
      return ids.length ? Math.max(...ids) : null;
    };

    const setPov = (name, pan) => {
      const id = idOf(name);
      if (id == null) {
        const available = Object.values(tagpro.players || {}).map(p => p.name).join(', ');
        log('POV MISS: "' + name + '" — available: [' + available + ']');
        return;
      }
      if (tagpro.viewport) {
        tagpro.viewport.followPlayer = true;
        if (pan && id !== tagpro.playerId) {
          // With pan set, TagPro eases the camera to the new player over 750 ms;
          // centerLock off makes the glide track them while they move.
          tagpro.viewport.centerLock = false;
          tagpro.viewport.pan = true;
          setTimeout(() => { tagpro.viewport.centerLock = true; }, 1000);
        }
      }
      tagpro.playerId = id;
      log('POV ' + (pan ? 'pan' : 'snap') + ' → ' + name + ' (id=' + id + ') at ' + now() + 'ms');
    };

    const onSeekComplete = () => {
      log('seek complete at ' + now() + 'ms, resuming playback');
      rp.play();

      const src = document.getElementById('viewport');
      if (!src) { reject('#viewport canvas not found'); return; }

      const w   = targetW || src.width  || 1280;
      const h   = targetH || src.height || 720;
      const rc  = document.createElement('canvas');
      rc.width  = w; rc.height = h;
      const ctx = rc.getContext('2d');
      ctx.globalCompositeOperation = 'copy';

      // TagPro's canvas is 16:10 (1280x800 native, scaled to fit the window), so
      // stretching it onto a 16:9 frame squashes everything by ~11%.  Instead take
      // a same-aspect crop: centred horizontally, anchored to the bottom so the
      // score/clock HUD stays and the FPS/ping readout at the top is what goes.
      const scale = Math.max(w / src.width, h / src.height);
      const sw = Math.round(w / scale), sh = Math.round(h / scale);
      const sx = Math.round((src.width - sw) / 2), sy = src.height - sh;

      const mimeType = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm']
        .find(t => MediaRecorder.isTypeSupported(t));
      if (!mimeType) { reject('No supported MediaRecorder MIME type'); return; }

      const mr = new MediaRecorder(rc.captureStream(60), {
        mimeType,
        videoBitsPerSecond: (bitrateMbps || 8) * 1_000_000,
      });
      const chunks = [];
      let rafId;
      mr.ondataavailable = e => e.data.size && chunks.push(e.data);
      mr.onstop = () => {
        cancelAnimationFrame(rafId);
        rp.pause();
        const blob = new Blob(chunks, { type: mimeType });
        const ext  = mimeType.includes('mp4') ? 'mp4' : 'webm';
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = 'tpclip_' + Date.now() + '.' + ext;
        document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 3000);
        log('done — ' + chunks.length + ' chunks, ext=' + ext);
        resolve(ext);
      };

      const pending   = (pov || []).filter(p => p && p.name).sort((a, b) => a.atMs - b.atMs);
      const playStart = performance.now();
      let povReady = pending.length === 0, framesOnPov = 0;
      let recording = false, recStart = 0, lastDraw = 0;

      // The seek bar stops reporting at its rounded max, a little before the replay's
      // true end.  A clip that runs to the end of the game (a game-winning cap) would
      // never see its end time on the bar, so once the bar is pinned the rest of the
      // clip is timed on the wall clock.
      const planEnd = sliderMs + durationMs;
      const barMax  = parseInt(bar.max, 10) || Infinity;
      let lastT = -1, lastAdvance = performance.now(), pinnedAt = null;

      const tick = ts => {
        const t = now();
        if (t !== lastT) { lastT = t; lastAdvance = performance.now(); }

        // First POV: as soon as the player is in the roster; give up waiting at the clip start.
        if (!povReady) {
          if (idOf(pending[0].name) != null || t >= sliderMs) {
            setPov(pending.shift().name, false);
            povReady = true;
          }
        } else if (!recording) {
          framesOnPov++;
        }

        if (ts - lastDraw >= 1000 / 60) { ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h); lastDraw = ts; }

        // Start once the replay reaches the clip and the renderer has drawn the first POV.
        if (!recording && povReady && framesOnPov >= 2 && t >= sliderMs) {
          mr.start(200);
          recording = true; recStart = performance.now();
          log('recording from ' + t + 'ms for ' + durationMs + 'ms');
        }
        if (!recording && performance.now() - playStart > 15000) {
          reject('replay never reached the clip start (' + sliderMs + 'ms, at ' + t + 'ms)');
          return;
        }

        if (recording) {
          while (pending.length && t >= sliderMs + pending[0].atMs) {
            const p = pending.shift();
            setPov(p.name, p.pan !== false);
          }
          const pinned = t >= barMax;
          if (pinned && pinnedAt == null) pinnedAt = performance.now();
          const done    = t >= planEnd || (pinned && performance.now() - pinnedAt >= planEnd - barMax);
          // A replay that stops advancing mid-way has stalled; the wall-clock limit is a last resort.
          const stalled = !pinned && performance.now() - lastAdvance > 400;
          if (done || stalled || performance.now() - recStart > durationMs + 3000) {
            log('stopping at ' + t + 'ms' + (done ? (pinned ? ' (end of replay)' : '') : stalled ? ' (replay stalled)' : ' (wall-clock limit)'));
            mr.stop();
            return;
          }
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    };
  });
`;


// ── Series / game resolution ───────────────────────────────────────────────

// Which in-game colour (red/blue) each series team played in this game, matched
// by the team name/abbreviation the TagPro server recorded in the NDJSON.
function teamColors(game, series) {
  const red  = game.meta?.teams?.red?.name;
  const blue = game.meta?.teams?.blue?.name;
  const is   = (n, t) => !!n && !!t && (n === t.abbreviation || n === t.name);
  if (is(red, series.home) || is(blue, series.away)) return { home: 'red',  away: 'blue' };
  if (is(blue, series.home) || is(red, series.away)) return { home: 'blue', away: 'red' };
  return { home: null, away: null };
}

// [homeScore, awayScore] for a game — from the replay when we know the colours,
// otherwise from MLTP, otherwise red/blue positional.
function homeAwayScore(game, colors) {
  const fs = game.finalScore;
  if (fs && colors.home) return colors.home === 'red' ? [fs.r, fs.b] : [fs.b, fs.r];
  if (game.mltpScore) return game.mltpScore;
  return fs ? [fs.r, fs.b] : null;
}

// Build the list of games to export from --mltp, --match, or a local NDJSON path.
async function resolveGames() {
  if (MLTP && MATCH_IDS.length) throw new Error('Use either --mltp or --match, not both');

  if (MLTP) {
    console.log(`\nFetching MLTP matchup ${MLTP} ...`);
    const m = await fetchMatchup(MLTP);
    await downloadTeamLogos(m, resolve('./output/logos'));
    const unmatched = applyLogoOverrides(m, LOGO_OVERRIDES);
    if (unmatched.length) {
      throw new Error(`--logo: no team matches "${unmatched[0].team}" — the teams are ` +
        `${m.home.name} (${m.home.abbreviation}) and ${m.away.name} (${m.away.abbreviation})`);
    }
    for (const t of [m.home, m.away]) if (t.logoOverridden) console.log(`  Logo override for this run: ${t.name} → ${t.logoPath}`);
    console.log(`  ${describeMatchup(m)}`);
    console.log(`  ${m.home.name} (${m.home.abbreviation}) vs ${m.away.name} (${m.away.abbreviation}) — best of ${m.bestOf}`);
    const games = [];
    for (const g of m.games) {
      const tag = `Game ${g.gameNumber} (${g.mapName || '?'})`;
      if (!g.matchId) {
        console.warn(`  ! ${tag}: no tagpro.eu replay link (status: ${g.status}) — skipping`);
        continue;
      }
      console.log(`  ${tag}: tagpro.eu match ${g.matchId}  score ${g.score?.join('-') ?? '?'}${g.overtime ? ' (OT)' : ''}`);
      games.push({ gameNumber: g.gameNumber, matchId: g.matchId, mapName: g.mapName, mltpScore: g.score, overtime: g.overtime });
    }
    if (!games.length) throw new Error('No games with tagpro.eu replays in this matchup');
    const series = {
      label:       describeMatchup(m),
      footer:      `mltp.gg · ${describeMatchup(m).replace(/^MLTP · /, '')}`,
      home:        m.home,
      away:        m.away,
      bestOf:      m.bestOf,
      scheduledAt: m.scheduledAt,
      seriesScore: m.seriesScore,
      allGames:    m.games,   // including games we could not export, for the final card
    };
    return { series, games };
  }

  if (MATCH_IDS.length) {
    const games = MATCH_IDS.map((id, i) => ({ gameNumber: i + 1, matchId: id }));
    return { series: null, games };
  }

  const ndjsonPath = positional[2]
    ?? `${process.env.HOME}/Downloads/tagpro-bwjtsdpz-rnfstdli.billdacat.ndjson`;
  return { series: null, games: [{ gameNumber: 1, ndjsonPath }] };
}

// Download (if needed), parse, and score one game.  Returns null when the replay
// is unavailable and we are exporting several games (so the rest still export).
async function prepareGame(game, multi) {
  console.log(`\n── Game ${game.gameNumber}${game.mapName ? ` · ${game.mapName}` : ''} ──`);
  if (game.matchId) {
    try {
      ({ ndjsonPath: game.ndjsonPath, replayKey: game.replayKey } = await lookupMatch(game.matchId));
    } catch (err) {
      if (!multi) throw err;
      console.warn(`  ! ${err.message}\n  ! Skipping game ${game.gameNumber}`);
      return null;
    }
  }
  console.log(`  NDJSON : ${game.ndjsonPath}`);

  const parsed = await parseReplay(game.ndjsonPath);
  const { events, playerIndex, meta, gameStartMs, actualDurationMs } = parsed;
  const regulationMs = meta?.duration;
  if (regulationMs && actualDurationMs > regulationMs) {
    const otSec = ((actualDurationMs - regulationMs) / 1000).toFixed(0);
    console.log(`  Overtime detected: +${otSec}s beyond regulation`);
  }

  // MAX_CLIPS caps the filler pool per game; all caps are always kept.
  let clips = scoreHighlights({ events, playerIndex, meta, gameStartMs, actualDurationMs, maxNonCapClips: MAX_CLIPS });
  if (CAPS_ONLY) clips = clips.filter(c => c.focalType === 'capture');
  if (DEBUG_CLIP) clips = clips.slice(0, 1);

  if (flag('replay')) {
    game.replayKey = flag('replay');
    console.log(`  Replay : ${game.replayKey} (from --replay flag)`);
  } else if (game.replayKey) {
    console.log(`  Replay : ${game.replayKey} (from --match lookup)`);
  } else {
    console.log('  Deriving replay key...');
    game.replayKey = await deriveReplayKey(meta);
    console.log(`  Replay : ${game.replayKey}`);
  }
  console.log(`  Map    : ${meta?.mapName ?? '?'}   Final: Red ${parsed.finalScore.r} – Blue ${parsed.finalScore.b}   Candidates: ${clips.length} clips`);

  return { ...game, ...parsed, mapName: game.mapName || meta?.mapName || '', clips };
}

// ── Reel planning ──────────────────────────────────────────────────────────
// Every cap is always in the reel, even when caps alone run past the target.
// If caps leave room, the best remaining plays (quick returns, big returns,
// long carries) fill the reel up to the target length.  A game with no caps
// still gets its best play so it does not vanish from the reel.

const clipSec = c => (c.endMs - c.startMs) / 1000;

function planReel(games, { multi, targetSec }) {
  const n = games.length;
  const cardSec = multi
    ? CARD_SECONDS.intro + CARD_SECONDS.final + n * (CARD_SECONDS.game + RECAP_SEC)
    : INTRO_SEC + RECAP_SEC + SCOREBOARD_SEC;
  // Overlapping joins: in cut mode only card boundaries dip to black (title→clips,
  // clips→recap, and between series segments); in the blend modes every join overlaps.
  const cut         = TRANSITION === 'cut';
  const cardJoins   = multi ? (cut ? 3 * n + 1 : 2 * n + 1) : 2;
  const cardOverlap = cut ? CARD_FADE_SEC : DISSOLVE_SEC;
  const clipOverlap = cut ? 0 : DISSOLVE_SEC;
  let total = cardSec - cardOverlap * cardJoins;

  const all  = games.flatMap(g => g.clips.map(c => ({ g, c, dur: clipSec(c), isCap: c.focalType === 'capture' })));
  const caps = all.filter(x => x.isCap);
  const pool = all.filter(x => !x.isCap).sort((a, b) => b.c.score - a.c.score || a.dur - b.dur);

  const chosen = new Set();
  const add = x => { chosen.add(x.c); total += x.dur - clipOverlap; };
  for (const x of caps) add(x);

  if (targetSec == null) {                       // --restitch: everything that was recorded
    for (const x of pool) add(x);
  } else {
    for (const g of games) {                     // a game with no caps keeps its best play
      if (!caps.some(x => x.g === g)) { const best = pool.find(x => x.g === g); if (best) add(best); }
    }
    for (const x of pool) {
      if (total >= targetSec) break;
      if (!chosen.has(x.c)) add(x);
    }
  }

  for (const g of games) g.clips = g.clips.filter(c => chosen.has(c));   // keeps chronological order
  const fillerUsed = [...chosen].filter(c => c.focalType !== 'capture').length;
  return { estimatedSec: total, caps: caps.length, fillerUsed, fillerUnused: pool.length - fillerUsed };
}

const fmtSec = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

function printPlan(games, plan, targetSec) {
  console.log('\nReel plan');
  console.log('=========');
  for (const g of games) {
    const caps = g.clips.filter(c => c.focalType === 'capture').length;
    console.log(`\nGame ${g.gameNumber}${g.mapName ? ` · ${g.mapName}` : ''}: ${g.clips.length} clips (${caps} caps, ${fmtSec(g.clips.reduce((s, c) => s + clipSec(c), 0))})`);
    g.clips.forEach((c, i) => {
      const sStart = g.gameStartMs + c.startMs, sEnd = g.gameStartMs + c.endMs;
      console.log(`  [${i + 1}] ${c.description}`);
      console.log(`       players: ${c.players.join(', ')}  |  slider: ${sStart}–${sEnd}ms  (${((sEnd - sStart) / 1000).toFixed(0)}s)`);
      if (c.povSchedule?.length > 1)
        console.log(`       camera: ${c.povSchedule.map(s => `${s.player} @${(s.atMs / 1000).toFixed(1)}s`).join(' → ')}`);
    });
  }
  const how = targetSec == null ? ''
    : plan.estimatedSec >= targetSec && plan.fillerUsed === 0 && plan.caps > 0
      ? ` (target ${fmtSec(targetSec)}; caps alone fill it)`
      : ` (target ${fmtSec(targetSec)}; ${plan.caps} caps + ${plan.fillerUsed} other plays, ${plan.fillerUnused} unused)`;
  console.log(`\nEstimated reel length: ~${fmtSec(plan.estimatedSec)}${how}`);
  if (targetSec != null && plan.estimatedSec < targetSec - 1)
    console.log(`  Short of the target: no more plays worth showing in the available games.`);
}

// ── Browser helpers ────────────────────────────────────────────────────────

async function openReplay(browser, context, replayKey, tagproCookies) {
  const url  = `https://tagpro.koalabeast.com/game?replay=${encodeURIComponent(replayKey)}`;
  const page = await context.newPage();
  console.log(`  Opening ${url} ...`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Session not valid → guide the user
  if (page.url().includes('/login') || page.url().includes('accounts.google')) {
    const msg = tagproCookies.length === 0
      ? 'No TagPro cookies found in Chrome. Make sure you\'re logged in, then:'
      : 'Session cookies expired. Log into TagPro in Chrome again, then:';
    console.error(`\n⚠  ${msg}\n`);
    console.error('     node src/export-replay-clips.js --login\n');
    await browser.close();
    process.exit(1);
  }

  // Wait for TagPro's replay engine to initialise
  console.log('  Waiting for TagPro to load...');
  await page.waitForFunction(
    () => window.tagpro?.players != null
       && document.getElementById('viewport') != null
       && document.getElementById('replaySeekBar') != null,
    { timeout: 90_000 }
  );
  await page.evaluate(RECORDER_SRC);
  // Surface the recorder's camera decisions (and misses) in the run log.
  page.on('console', m => {
    const t = m.text();
    if (t.startsWith('[tp-export]') && /POV|never reached|timed out|end of replay|stalled|wall-clock/.test(t)) console.log(`    ${t.slice(12)}`);
  });
  console.log('  TagPro loaded.');
  return page;
}

// Record one clip via the in-page MediaRecorder, save the download, return an MP4 path.
async function recordClip(page, clipsDir, label, { sliderMs, durationMs, pov = [] }) {
  const downloadPromise = page.waitForEvent('download', { timeout: durationMs + 60_000 });
  downloadPromise.catch(() => {});   // if the page goes away, the evaluate below reports it
  const ext = await page.evaluate(
    ({ sliderMs, durationMs, pov }) => window.__tpRecord(sliderMs, durationMs, 1280, 720, 8, pov),
    { sliderMs, durationMs, pov }
  );
  const dl      = await downloadPromise;
  const rawPath = `${clipsDir}/${label}.${ext}`;
  await dl.saveAs(rawPath);
  if (ext === 'mp4') return rawPath;

  const finalPath = `${clipsDir}/${label}.mp4`;
  console.log('  Converting WebM → MP4...');
  execFileSync('ffmpeg', [
    '-y', '-i', rawPath,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    finalPath,
  ]);
  return finalPath;
}

// Record the intro clip plus every planned highlight clip for one game.
async function recordGame(page, game) {
  const { clipsDir, gameStartMs, clips } = game;

  // Intro clip — 4 s of gameplay from the flags-live moment.  Two purposes:
  //  a) Creative cold-open for single-game reels (shows the initial rush).
  //  b) Sprite warm-up: seeking to gameStartMs processes all player-join events
  //     (including mid-game reconnects) so every ball is initialised in the
  //     renderer.  Later seeks keep those sprites, fixing the "invisible player"
  //     issue that occurs on a cold first seek.  Always recorded for that reason.
  console.log('  Recording intro clip (game start)...');
  game.introPath = await recordClip(page, clipsDir, 'intro', { sliderMs: gameStartMs, durationMs: INTRO_SEC * 1000 });
  console.log(`  ✓ intro.mp4  (${(gameStartMs / 1000).toFixed(1)}s mark)\n`);

  game.clipPaths = [];
  // In the blend modes each clip starts on the previous clip's focal player and switches
  // POV mid-blend so the overlap shows one map region.  Hard cuts have no overlap, so
  // every clip simply starts on its own focal player.
  const blendPov    = TRANSITION !== 'cut';
  let prevFocal     = null;
  const povSwitchMs = Math.round(DISSOLVE_SEC * 500);  // switch at 50% of the blend

  for (let i = 0; i < clips.length; i++) {
    const clip  = clips[i];
    const focal = clip.focalPlayer ?? clip.players[0];
    const label = clip.label;

    // Camera plan: the clip's own schedule (one stop per capper), panning between stops.
    let pov = (clip.povSchedule?.length ? clip.povSchedule : [{ atMs: 0, player: focal }])
      .map(s => ({ atMs: s.atMs, name: s.player, pan: s.atMs > 0 }));
    if (blendPov && prevFocal && prevFocal !== pov[0].name) {
      pov = [{ atMs: 0, name: prevFocal, pan: false },
             { atMs: povSwitchMs, name: pov[0].name, pan: false },
             ...pov.slice(1).filter(s => s.atMs > povSwitchMs)];
    }

    // --debug-clip: record only clip 1, from t=0 through the focal event,
    // so you can watch where the focal player is throughout the game start.
    const sliderMs   = (DEBUG_CLIP && i === 0) ? 0 : gameStartMs + clip.startMs;
    const clipEndMs  = gameStartMs + clip.endMs;
    const durationMs = (DEBUG_CLIP && i === 0) ? clipEndMs : clip.endMs - clip.startMs;

    console.log(`  [${i + 1}/${clips.length}] ${clip.description}`);
    if (DEBUG_CLIP && i === 0)
      console.log(`    DEBUG: recording from t=0 → ${clipEndMs}ms (${(clipEndMs / 1000).toFixed(0)}s)`);
    console.log(`    camera: ${pov.map(s => `${s.name}@${(s.atMs / 1000).toFixed(1)}s`).join(' → ')}  |  slider=${sliderMs}ms  dur=${(durationMs / 1000).toFixed(0)}s`);

    try {
      const path = await recordClip(page, clipsDir, label, { sliderMs, durationMs, pov });
      game.clipPaths.push(path);
      prevFocal = blendPov ? pov.at(-1).name : null;
      console.log(`    ✓ ${label}.mp4\n`);
    } catch (err) {
      console.error(`    ✗ ${label} failed: ${err.message}`);
      console.error(`    Keeping the ${game.clipPaths.length} clip(s) recorded so far for this game.\n`);
      break;
    }
  }
  game.clips = game.clips.slice(0, game.clipPaths.length);   // keep clips and files aligned
}

// ── Main ───────────────────────────────────────────────────────────────────
console.log('\nTagPro Replay Clip Exporter');
console.log('============================');

// --login: sign in first, before anything reads the session cookies.
if (LOGIN_MODE) {
  console.log('\nOpening Chrome for TagPro login...');
  execFileSync('open', ['https://tagpro.koalabeast.com/login']);
  console.log('  Log in with your Google account in the Chrome window.');
  console.log('  Press Enter once you\'re on the TagPro home page...\n');
  await new Promise(resolve => {
    process.stdin.resume();
    process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
  });
  console.log('Cookies will be read from Chrome\'s profile. Continuing...\n');
}

// 1. Resolve which games to export, then download/parse/score each one.
const { series: mltpSeries, games: requested } = await resolveGames();
const multi = requested.length > 1 || !!MLTP;
if (multi && flag('replay')) throw new Error('--replay only applies to a single game');

const games = [];
for (const g of requested) {
  const prepared = await prepareGame(g, multi);
  if (prepared) games.push(prepared);
}
if (!games.length) { console.error('\nNo games could be prepared'); process.exit(1); }
if (!games.some(g => g.clips.length)) { console.error('\nNo highlights found'); process.exit(1); }

// Series metadata: from MLTP, or derived from game 1's red/blue teams.
const series = mltpSeries ?? (multi ? {
  label:       `${games.length}-game series`,
  footer:      '',
  home:        { name: games[0].meta?.teams?.red?.name  ?? 'Red',  abbreviation: games[0].meta?.teams?.red?.name  ?? 'RED',  colorHex: null },
  away:        { name: games[0].meta?.teams?.blue?.name ?? 'Blue', abbreviation: games[0].meta?.teams?.blue?.name ?? 'BLUE', colorHex: null },
  bestOf:      games.length,
  scheduledAt: null,
  seriesScore: null,
  allGames:    null,
} : null);

// What the end-of-game scoreboard cards need beyond the replay itself.
for (const g of games) {
  g.cardExtras = { source: g.matchId ? `tagpro.eu #${g.matchId}` : '' };
  if (!multi) continue;
  g.colors = teamColors(g, series);
  g.homeAwayScore = homeAwayScore(g, g.colors);
  Object.assign(g.cardExtras, {
    gameNumber: g.gameNumber,
    totalGames: series.bestOf ?? games.length,
    label:      mltpSeries ? series.label : '',
    overtime:   mltpSeries ? !!g.overtime : undefined,   // otherwise judged from the game length
  });
  if (g.colors.home) {       // full names and logos, mapped to the colour each team played
    g.cardExtras.teamNames = { [g.colors.home]: series.home.name,     [g.colors.away]: series.away.name };
    g.cardExtras.teamLogos = { [g.colors.home]: series.home.logoPath, [g.colors.away]: series.away.logoPath };
  }
}

// 2. Output layout
//    single game : output/clips/*.mp4                 → output/game-summary.mp4
//    multi game  : output/match/game_NN/clips/*.mp4   → output/match/game_NN/game-summary.mp4
//                  output/match/cards/*.mp4           → output/match-highlights.mp4
const OUT_DIR   = resolve('./output');
const MATCH_DIR = `${OUT_DIR}/match`;
for (const g of games) {
  g.dir      = multi ? `${MATCH_DIR}/game_${String(g.gameNumber).padStart(2, '0')}` : OUT_DIR;
  g.clipsDir = `${g.dir}/clips`;
  g.planPath = `${g.dir}/plan.json`;
}

// 3. Plan the reel against the duration budget.  With --restitch, reload the plan
//    the recording run saved so the existing clip files line up with it.
const targetSec = TARGET_MINUTES * 60;
if (RESTITCH) {
  for (const g of games) {
    if (!existsSync(g.planPath)) throw new Error(`--restitch: ${g.planPath} not found — record this game first`);
    const saved = JSON.parse(readFileSync(g.planPath, 'utf8'));
    g.clips     = saved.clips.filter(c => {
      const ok = existsSync(`${g.clipsDir}/${c.label}.mp4`);
      if (!ok) console.warn(`  ! ${g.clipsDir}/${c.label}.mp4 missing — skipping that clip`);
      return ok;
    });
    g.clipPaths = g.clips.map(c => `${g.clipsDir}/${c.label}.mp4`);
    g.introPath = `${g.clipsDir}/intro.mp4`;
  }
  printPlan(games, planReel(games, { multi, targetSec: null }), null);
} else {
  const plan = planReel(games, { multi, targetSec });
  printPlan(games, plan, targetSec);
  if (DRY_RUN) { console.log('\n--dry-run: stopping before recording.'); process.exit(0); }
  for (const g of games) {
    mkdirSync(g.clipsDir, { recursive: true });
    g.clips.forEach((c, i) => { c.label = `clip_${String(i + 1).padStart(2, '0')}`; });
    writeFileSync(g.planPath, JSON.stringify({
      gameNumber: g.gameNumber, matchId: g.matchId ?? null, mapName: g.mapName,
      replayKey: g.replayKey, clips: g.clips,
    }, null, 2));
  }
}
if (multi) mkdirSync(`${MATCH_DIR}/cards`, { recursive: true });

if (!RESTITCH) {
  // 4. Auth: the TagPro session cookies from Chrome, injected into Playwright's Chromium.
  console.log('');
  const tagproCookies = getTagproCookies();

  // Launch Playwright's own Chromium (no system Chrome needed)
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: false });
  // 1280x800 matches TagPro's native 16:10 canvas, so the recorder's 16:9 crop is 1:1 pixels.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  if (tagproCookies.length > 0) await context.addCookies(tagproCookies);

  // 5. Record every game (one fresh tab per replay).
  const browserGone = () => {
    console.error('\nThe recording browser was closed, so recording stopped.');
    console.error('Run the same command again to record, keeping that window open until it finishes.');
    process.exit(1);
  };
  for (const [i, g] of games.entries()) {
    if (!browser.isConnected()) browserGone();
    console.log(`\n[Game ${g.gameNumber}] (${i + 1}/${games.length}) ${g.mapName || ''}`);
    const page = await openReplay(browser, context, g.replayKey, tagproCookies).catch(err => {
      if (!browser.isConnected()) browserGone();
      throw err;
    });
    await recordGame(page, g);
    if (!browser.isConnected()) browserGone();
    await page.close();
  }
  await browser.close();
}

// Result rows for every game in the series, including games we could not export
// (MLTP knows their scores), so running series scores stay right on the title cards.
const exported   = new Map(games.map(g => [g.gameNumber, g]));
const seriesRows = !multi ? [] : (series.allGames ?? games).map(o => {
  const g = exported.get(o.gameNumber);
  return {
    gameNumber: o.gameNumber,
    mapName:    g?.mapName ?? o.mapName ?? '',
    score:      g?.homeAwayScore ?? o.score ?? null,
    overtime:   !!(o.overtime ?? g?.overtime),
  };
});

const seg = (path, kind) => ({ path, kind });

// 6. Captions, per-game ending cards, per-game stitch.
for (const g of games) {
  const { clipsDir, meta } = g;
  console.log(`\n[Game ${g.gameNumber}] Finishing...`);

  // Lower-third caption burned onto the opening seconds of each clip.
  let clipPaths = g.clipPaths;
  if (CAPTIONS && g.clips.length) {
    const teamNames = { red: meta?.teams?.red?.name, blue: meta?.teams?.blue?.name };
    clipPaths = g.clips.map((c, i) => {
      const src = g.clipPaths[i];
      const out = src.replace(/\.mp4$/, '.captioned.mp4');
      const items = captionsFor(c, { gameNumber: multi ? g.gameNumber : null, teamNames }).map((cap, k) => {
        const png = src.replace(/\.mp4$/, `.caption${k ? `-${k + 1}` : ''}.png`);
        renderCaptionPng(png, cap);
        return { png, atSec: cap.atSec };
      });
      burnCaptions(src, items, out);
      return out;
    });
    console.log(`  ✓ captions burned onto ${clipPaths.length} clip(s)`);
  }

  console.log('  Generating team comparison card...');
  const board = buildScoreboardData(g, g.cardExtras);
  makeCompareCard(`${clipsDir}/recap.png`, `${clipsDir}/recap.mp4`, board, RECAP_SEC);
  console.log('  ✓ recap.mp4');

  let segments;
  if (multi) {
    // Multi-game reels open each game with a title card instead of the cold-open
    // intro, and close with the team comparison card only (the full box score is
    // skipped to keep the series reel tight).
    // Shown before this game's clips, so it covers earlier games only.
    const seriesScore = seriesScoreEntering(seriesRows, g.gameNumber);
    makeGameTitleCard(`${clipsDir}/title.png`, `${clipsDir}/title.mp4`, {
      gameNumber: g.gameNumber, totalGames: series.bestOf ?? games.length,
      mapName: g.mapName, seriesScore, colors: g.colors,
      home: series.home, away: series.away, footer: series.footer,
    });
    console.log('  ✓ title.mp4');
    segments = [seg(`${clipsDir}/title.mp4`, 'card'), ...clipPaths.map(p => seg(p, 'clip')), seg(`${clipsDir}/recap.mp4`, 'card')];
  } else {
    console.log('  Generating box score card...');
    makeBoxScoreCard(`${clipsDir}/scoreboard.png`, `${clipsDir}/scoreboard.mp4`, board, SCOREBOARD_SEC);
    console.log('  ✓ scoreboard.mp4');
    segments = [seg(g.introPath, 'clip'), ...clipPaths.map(p => seg(p, 'clip')),
                seg(`${clipsDir}/recap.mp4`, 'card'), seg(`${clipsDir}/scoreboard.mp4`, 'card')];
  }

  g.reelPath = `${g.dir}/game-summary.mp4`;
  stitch(segments, g.reelPath);
  console.log(`  ✓ ${g.reelPath}`);
}

if (!multi) {
  console.log(`\n✓ ${games[0].reelPath}`);
  console.log(`  open "${games[0].reelPath}"`);
  process.exit(0);
}

// 7. Series cards + final stitch: intro card, each game's reel, series final card.
const cardsDir = `${MATCH_DIR}/cards`;
console.log('\nGenerating series cards...');
makeSeriesIntroCard(`${cardsDir}/series-intro.png`, `${cardsDir}/series-intro.mp4`, {
  label: series.label, home: series.home, away: series.away,
  bestOf: series.bestOf, scheduledAt: series.scheduledAt, footer: series.footer,
});
makeSeriesFinalCard(`${cardsDir}/series-final.png`, `${cardsDir}/series-final.mp4`, {
  home: series.home, away: series.away,
  seriesScore: series.seriesScore ?? seriesScoreAfter(seriesRows),
  games: seriesRows, footer: series.footer,
});
console.log('  ✓ series-intro.mp4, series-final.mp4');

const REEL = `${OUT_DIR}/match-highlights.mp4`;
console.log('\nStitching series reel...');
stitch([seg(`${cardsDir}/series-intro.mp4`, 'card'), ...games.map(g => seg(g.reelPath, 'card')), seg(`${cardsDir}/series-final.mp4`, 'card')], REEL);

console.log(`\n✓ ${REEL}  (~${fmtSec(getVideoDurationSec(REEL))})`);
console.log(`  open "${REEL}"`);
