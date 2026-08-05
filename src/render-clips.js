import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, join, extname } from 'path';
import { parseReplay } from './parse-replay.js';
import { buildFrameData } from './build-frame-data.js';

const OUTPUT_DIR = resolve('./output/clips');
const RENDERER_DIR = resolve('./src/renderer');
const FRAME_DATA_DIR = resolve('./output/frame-data');
const PORT = 7890;

mkdirSync(OUTPUT_DIR, { recursive: true });
mkdirSync(FRAME_DATA_DIR, { recursive: true });

// ── Static file server ──────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
};

function startServer() {
  return new Promise(res => {
    const server = createServer((req, rsp) => {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      let filePath;
      if (pathname.startsWith('/frame-data/')) {
        filePath = join(FRAME_DATA_DIR, pathname.slice('/frame-data/'.length));
      } else {
        filePath = join(RENDERER_DIR, pathname === '/' ? 'index.html' : pathname);
      }
      try {
        const body = readFileSync(filePath);
        rsp.writeHead(200, {
          'Content-Type': MIME[extname(filePath)] ?? 'text/plain',
          'Access-Control-Allow-Origin': '*',
        });
        rsp.end(body);
      } catch {
        rsp.writeHead(404); rsp.end('Not found: ' + filePath);
      }
    });
    server.listen(PORT, () => res(server));
  });
}

// ── Main ────────────────────────────────────────────────────────────────
function fmtMs(ms) {
  if (!ms) return '0:00';
  const m = Math.floor(ms / 60000);
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${m}:${s}`;
}

const replayPath = process.argv[2]
  ?? `${process.env.HOME}/Downloads/tagpro-bwjtsdpz-rnfstdli.billdacat.ndjson`;
const manifestPath = process.argv[3] ?? './highlight-manifest.json';

const clipFilter = process.argv[4] ? [Number(process.argv[4])] : null; // optional: single clip index

console.log('\nTagPro Clip Renderer');
console.log('='.repeat(50));
console.log('Replay:', replayPath);
console.log('Manifest:', manifestPath);

console.log('\nParsing replay...');
const { events, playerIndex, gameStartMs } = await parseReplay(replayPath);

// Read raw records for frame builder (need full p event history)
const raw = readFileSync(replayPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const clips = clipFilter
  ? manifest.clips.filter(c => clipFilter.includes(c.index))
  : manifest.clips;

console.log(`\nBuilding frame data for ${clips.length} clip(s)...`);
for (const clip of clips) {
  const data = buildFrameData({ records: raw, clip, allEvents: events, gameStartMs });
  const dataFile = join(FRAME_DATA_DIR, `clip-${clip.index}.json`);
  writeFileSync(dataFile, JSON.stringify(data));
  console.log(`  Clip ${clip.index}: ${data.frames.length} frames → ${dataFile}`);
}

console.log('\nStarting server...');
const server = await startServer();
console.log(`  Listening on http://localhost:${PORT}`);

console.log('\nLaunching Chromium...');
const browser = await chromium.launch({ headless: true });

const videoPaths = [];
for (const clip of clips) {
  console.log(`\n  Rendering clip ${clip.index}: ${clip.description}`);
  console.log(`  Duration: ${(clip.durationMs / 1000).toFixed(1)}s  [${fmtMs(clip.startMs)}–${fmtMs(clip.endMs)}]`);

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: OUTPUT_DIR, size: { width: 1280, height: 720 } },
  });

  const page = await context.newPage();
  const dataUrl = encodeURIComponent(`/frame-data/clip-${clip.index}.json`);
  await page.goto(`http://localhost:${PORT}/?data=${dataUrl}`);

  // Wait for clip duration + a small buffer; headless RAF runs as fast as possible
  // so we rely on wall-clock time rather than a DONE signal.
  await page.waitForTimeout(clip.durationMs + 1500);

  const videoPath = await page.video()?.path();
  await context.close();

  if (videoPath) {
    const dest = join(OUTPUT_DIR, `clip-${String(clip.index).padStart(2, '0')}.webm`);
    // Playwright names the file automatically; rename it
    const { renameSync } = await import('fs');
    try { renameSync(videoPath, dest); videoPaths.push(dest); }
    catch { videoPaths.push(videoPath); }
    console.log(`  ✓ Saved: ${dest}`);
  }
}

await browser.close();
server.close();

console.log(`\n${'='.repeat(50)}`);
console.log(`Rendered ${videoPaths.length} clip(s):`);
for (const p of videoPaths) console.log(' ', p);
console.log('\nDone.');
