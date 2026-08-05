// Burns all VGS events onto CAPS.mov using ffmpeg overlay + audio mix.
// Events: BilldaCat V→A→F @8s, V→G→W @17s, V→T→G @25s
//         Cbad chat-only @21s, Kobe Maybe chat-only @28.5s
// Usage: node src/render-vgs-overlay.js [input.mov]

import { execFileSync, execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const INPUT = process.argv[2] ?? `${process.env.HOME}/Downloads/CAPS.mov`;
const OUT   = resolve('./output/vgs-overlay.mp4');
const AUDIO = resolve('./output/audio');
const OVLS  = resolve('./output/overlays');

const SW = 884, SH = 672;
mkdirSync('./output', { recursive: true });

if (!existsSync(INPUT)) { console.error(`Not found: ${INPUT}`); process.exit(1); }

// ── Step 1: generate audio files ──────────────────────────────────────────
const audioFiles = [
  'billdacat-attack.wav', 'billdacat-woohoo.wav', 'billdacat-gate.wav',
  'cbad-handoff.wav', 'kobemaybe-idiots.wav',
];
if (audioFiles.some(f => !existsSync(`${AUDIO}/${f}`))) {
  console.log('Generating audio...');
  execSync(`node ${resolve(__dir, 'generate-audio.js')}`, { stdio: 'inherit' });
}

// ── Step 2: generate overlay PNGs ─────────────────────────────────────────
const ovlFiles = [
  'ovl_phase1.png', 'ovl_p2_attack.png', 'ovl_p2_global.png', 'ovl_p2_team.png',
  'ovl_chat_attack.png', 'ovl_chat_woohoo.png', 'ovl_chat_handoff.png',
  'ovl_chat_gate.png',   'ovl_chat_idiots.png',
];
if (ovlFiles.some(f => !existsSync(`${OVLS}/${f}`))) {
  console.log('Generating overlay PNGs...');
  execFileSync('python3', [resolve(__dir, 'gen_vgs_overlays.py'), SW, SH, OVLS], { stdio: 'inherit' });
}

// ── Event table ────────────────────────────────────────────────────────────
// type 'vgs'  → phases: T0=V-menu (0.3s), T1=submenu (0.3s), T2=chat; audio at T0+0.7
// type 'chat' → no menu overlay; chat starts at T0; audio at T0 (immediate)
const CHAT_DUR = 2.5;  // seconds chat message stays visible

const events = [
  {
    t: 8.0,  type: 'vgs',
    phase1: 'ovl_phase1.png', phase2: 'ovl_p2_attack.png',
    chat:   'ovl_chat_attack.png',
    audio:  'billdacat-attack.wav', audioDelta: 0.7,
  },
  {
    t: 17.0, type: 'vgs',
    phase1: 'ovl_phase1.png', phase2: 'ovl_p2_global.png',
    chat:   'ovl_chat_woohoo.png',
    audio:  'billdacat-woohoo.wav', audioDelta: 0.7,
  },
  {
    t: 21.0, type: 'chat',
    chat:  'ovl_chat_handoff.png',
    audio: 'cbad-handoff.wav', audioDelta: 0,
  },
  {
    t: 25.0, type: 'vgs',
    phase1: 'ovl_phase1.png', phase2: 'ovl_p2_team.png',
    chat:   'ovl_chat_gate.png',
    audio:  'billdacat-gate.wav', audioDelta: 0.7,
  },
  {
    t: 28.5, type: 'chat',
    chat:  'ovl_chat_idiots.png',
    audio: 'kobemaybe-idiots.wav', audioDelta: 0,
  },
];

// ── Build ffmpeg filter_complex ────────────────────────────────────────────
// Escape commas for ffmpeg's filter option value parser (execFileSync, no shell)
const btw = (t0, t1) => `between(t\\,${t0.toFixed(2)}\\,${t1.toFixed(2)})`;

// ffmpeg inputs: collect in order
// [0] = CAPS.mov
// [1..N] = overlay PNGs (-loop 1)
// [N+1..] = audio WAVs
const imgInputs  = [];  // { path, label }
const audioInputs = []; // { path, delayMs }

// Assign image input indices starting at 1
const imgIdx = {};
const getImg = (fname) => {
  if (imgIdx[fname] === undefined) {
    imgIdx[fname] = 1 + imgInputs.length;
    imgInputs.push(`${OVLS}/${fname}`);
  }
  return imgIdx[fname];
};

events.forEach(ev => {
  if (ev.type === 'vgs') { getImg(ev.phase1); getImg(ev.phase2); }
  getImg(ev.chat);
  audioInputs.push({
    path:    `${AUDIO}/${ev.audio}`,
    delayMs: Math.round((ev.t + ev.audioDelta) * 1000),
  });
});

// Build the filter chain
const filterLines = [];

// Split the shared phase1 PNG (used 3 times: one per VGS event)
const phase1Idx = imgIdx['ovl_phase1.png'];
const vgsEvents = events.filter(e => e.type === 'vgs');
if (vgsEvents.length > 0) {
  filterLines.push(`[${phase1Idx}:v]split=${vgsEvents.length}${vgsEvents.map((_, i) => `[ph1_${i}]`).join('')}`);
}

filterLines.push(`[0:v]scale=${SW}:${SH}[sc]`);

let chainOut = 'sc';
let ph1Count = 0;
events.forEach((ev, ei) => {
  const out = ei === events.length - 1 ? 'vout' : `v${String(ei+1).padStart(2,'0')}`;

  if (ev.type === 'vgs') {
    const T0 = ev.t, T1 = T0 + 0.3, T2 = T1 + 0.3, T3 = T2 + CHAT_DUR;
    const p2idx = imgIdx[ev.phase2];
    const ciidx = imgIdx[ev.chat];
    const ph1label = `ph1_${ph1Count++}`;
    const mid1 = `${chainOut}_va`;
    const mid2 = `${chainOut}_vb`;

    filterLines.push(`[${chainOut}][${ph1label}]overlay=0:0:format=auto:enable=${btw(T0,T1)}[${mid1}]`);
    filterLines.push(`[${mid1}][${p2idx}:v]overlay=0:0:format=auto:enable=${btw(T1,T2)}[${mid2}]`);
    filterLines.push(`[${mid2}][${ciidx}:v]overlay=0:0:format=auto:enable=${btw(T2,T3)}[${out}]`);
    chainOut = out;
  } else {
    const T0 = ev.t, T1 = T0 + CHAT_DUR;
    const ciidx = imgIdx[ev.chat];
    filterLines.push(`[${chainOut}][${ciidx}:v]overlay=0:0:format=auto:enable=${btw(T0,T1)}[${out}]`);
    chainOut = out;
  }
});

// Audio: delay each stream, then amix
const firstAudioIdx = 1 + imgInputs.length;
audioInputs.forEach((a, i) => {
  filterLines.push(`[${firstAudioIdx + i}:a]adelay=${a.delayMs}|${a.delayMs}[a${i}]`);
});
const aMixInputs = audioInputs.map((_, i) => `[a${i}]`).join('');
filterLines.push(`${aMixInputs}amix=inputs=${audioInputs.length}:normalize=0[aout]`);

const filterComplex = filterLines.join(';');

// ── Build ffmpeg args ──────────────────────────────────────────────────────
const args = ['-y', '-i', INPUT];
imgInputs.forEach(p  => args.push('-loop', '1', '-i', p));
audioInputs.forEach(a => args.push('-i', a.path));
args.push(
  '-filter_complex', filterComplex,
  '-map', '[vout]',
  '-map', '[aout]',
  '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
  '-c:a', 'aac', '-b:a', '128k',
  '-pix_fmt', 'yuv420p',
  '-t', '30.86',
  OUT,
);

console.log('\nTagPro VGS Multi-Event Overlay');
console.log('==============================');
console.log(`Input   : ${INPUT}`);
console.log(`Output  : ${OUT}`);
console.log(`Events  : ${events.length} (${events.filter(e=>e.type==='vgs').length} VGS + ${events.filter(e=>e.type==='chat').length} chat-only)`);
console.log(`Overlays: ${imgInputs.length} PNGs, ${audioInputs.length} audio tracks\n`);

events.forEach(ev => {
  const tag = ev.type === 'vgs' ? `VGS  t=${ev.t}s` : `chat t=${ev.t}s`;
  console.log(`  ${tag}  ${ev.audio}`);
});

console.log('\nRunning ffmpeg...\n');
try {
  execFileSync('ffmpeg', args, { stdio: 'inherit' });
  console.log(`\n✓ ${OUT}`);
  console.log(`  open "${OUT}"`);
} catch {
  process.exit(1);
}
