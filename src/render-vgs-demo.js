// Renders a VGS demo clip: gameplay + scripted VGS overlay + voice line mixed in via ffmpeg.
// Usage: node src/render-vgs-demo.js [replayPath] [clipIndex] [triggerMs] [voicePack]
// Defaults: clip 3, triggerMs=3000, voicePack=alex

import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, join, extname } from 'path';
import { execSync } from 'child_process';
import { parseReplay } from './parse-replay.js';
import { buildFrameData } from './build-frame-data.js';

const OUTPUT_DIR   = resolve('./output');
const CLIPS_DIR    = resolve('./output/clips');
const AUDIO_DIR    = resolve('./output/audio');
const FRAME_DIR    = resolve('./output/frame-data');
const RENDERER_DIR = resolve('./src/renderer');
const PORT = 7891; // different port so it doesn't conflict with render-clips.js

mkdirSync(CLIPS_DIR,  { recursive: true });
mkdirSync(FRAME_DIR,  { recursive: true });

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
        filePath = join(FRAME_DIR, pathname.slice('/frame-data/'.length));
      } else {
        filePath = join(RENDERER_DIR, pathname === '/' ? 'vgs.html' : pathname);
      }
      try {
        const body = readFileSync(filePath);
        rsp.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'text/plain',
                             'Access-Control-Allow-Origin': '*' });
        rsp.end(body);
      } catch {
        rsp.writeHead(404); rsp.end('Not found: ' + filePath);
      }
    });
    server.listen(PORT, () => res(server));
  });
}

// ── Args ──────────────────────────────────────────────────────────────────
const replayPath  = process.argv[2] ?? `${process.env.HOME}/Downloads/tagpro-bwjtsdpz-rnfstdli.billdacat.ndjson`;
const clipIndex   = Number(process.argv[3] ?? 3);
const triggerMs   = Number(process.argv[4] ?? 3000);
const voicePack   = process.argv[5] ?? 'alex';
const audioFile   = join(AUDIO_DIR, `vgs-${voicePack}.wav`);

console.log('\nTagPro VGS Demo Renderer');
console.log('='.repeat(50));
console.log(`Replay   : ${replayPath}`);
console.log(`Clip     : #${clipIndex}`);
console.log(`VGS fires: at t=${triggerMs}ms into clip`);
console.log(`Voice    : ${voicePack} (${audioFile})`);

if (!existsSync(audioFile)) {
  console.error(`\n✗ Audio file not found: ${audioFile}`);
  console.error('  Run: node src/generate-audio.js');
  process.exit(1);
}

// ── Build frame data ───────────────────────────────────────────────────────
console.log('\nParsing replay...');
const { events, playerIndex, gameStartMs } = await parseReplay(replayPath);
const raw = readFileSync(replayPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));

const manifest = JSON.parse(readFileSync('./highlight-manifest.json', 'utf8'));
const clip = manifest.clips.find(c => c.index === clipIndex);
if (!clip) { console.error(`Clip ${clipIndex} not in manifest`); process.exit(1); }

console.log(`Building frame data for clip ${clipIndex}: "${clip.description}"...`);
const frameData = buildFrameData({ records: raw, clip, allEvents: events, gameStartMs });
const dataFile  = join(FRAME_DIR, 'vgs-clip.json');
writeFileSync(dataFile, JSON.stringify(frameData));
console.log(`  ${frameData.frames.length} frames → ${dataFile}`);

// ── VGS config ─────────────────────────────────────────────────────────────
// Find BilldaCat or the focal player of the clip for the chat line
const focalPlayer = manifest.players.find(p => p.name === clip.players[0]) ?? manifest.players[0];
const vgsConfig = {
  triggerMs,
  sequence: ['V', 'A', 'F'],
  phrase: 'I am attacking the flag!',
  playerName: 'BilldaCat',
  team: 2,
};

// ── Playwright render ──────────────────────────────────────────────────────
const rawWebm = join(CLIPS_DIR, 'vgs-raw.webm');
const finalMp4 = join(OUTPUT_DIR, 'vgs-demo.mp4');

console.log('\nStarting server...');
const server = await startServer();

console.log('Launching Chromium...');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: CLIPS_DIR, size: { width: 1280, height: 720 } },
});

const page = await context.newPage();
const dataUrl   = encodeURIComponent('/frame-data/vgs-clip.json');
const vgsParam  = encodeURIComponent(JSON.stringify(vgsConfig));
await page.goto(`http://localhost:${PORT}/?data=${dataUrl}&vgs=${vgsParam}`);

console.log(`  Rendering ${(clip.durationMs/1000).toFixed(0)}s clip...`);
await page.waitForTimeout(clip.durationMs + 1500);

const videoPath = await page.video()?.path();
await context.close();
await browser.close();
server.close();

if (!videoPath) { console.error('No video captured'); process.exit(1); }

const { renameSync } = await import('fs');
try { renameSync(videoPath, rawWebm); } catch { /* already at rawWebm */ }
console.log(`  Raw video: ${rawWebm}`);

// ── ffmpeg: mix audio into video ───────────────────────────────────────────
// Audio starts at triggerMs + 700ms (just after the F keypress at +600ms)
const audioDelayMs = triggerMs + 700;

console.log(`\nMixing audio (delay ${audioDelayMs}ms)...`);

const ffmpegCmd = [
  'ffmpeg -y',
  `-i "${rawWebm}"`,
  `-i "${audioFile}"`,
  `-filter_complex "[1:a]adelay=${audioDelayMs}|${audioDelayMs}[delayed]"`,
  `-map 0:v`,
  `-map "[delayed]"`,
  `-c:v libx264 -preset fast -crf 18`,  // transcode VP8→H.264 for MP4 container
  `-c:a aac -b:a 128k`,
  `"${finalMp4}"`,
].join(' ');

try {
  execSync(ffmpegCmd, { stdio: 'pipe' });
  console.log(`  ✓ ${finalMp4}`);
} catch (e) {
  console.error('ffmpeg failed:', e.stderr?.toString() ?? e.message);
  process.exit(1);
}

console.log('\n' + '='.repeat(50));
console.log('Done.');
console.log(`\n  open "${finalMp4}"`);
