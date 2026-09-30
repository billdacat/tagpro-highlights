// Lower-third captions burned onto the opening seconds of each highlight clip.
// The badge PNG is rendered by src/series_cards.py ('caption' mode); ffmpeg then
// slides it in from the left, holds, and fades it out.

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir    = dirname(fileURLToPath(import.meta.url));
const CARDS_PY = resolve(__dir, 'series_cards.py');

export const CAPTION = {
  x: 24, y: 28,            // top-left; the recorder crops TagPro's FPS/ping readout away
  delaySec: 0.2, fadeInSec: 0.25, holdSec: 3.4, fadeOutSec: 0.4,
};

const EVENT_LABEL = { capture: 'Capture', return: 'Return', tag: 'Tag', grab: 'Grab', drop: 'Drop' };

// Build the captions for a clip: one per camera stop, shown when the camera gets there.
// A clip with two captures therefore names each capper in turn.  Team words in the
// scorer's description ("Red"/"Blue") are swapped for the team names the server
// recorded, which match the on-screen score bar.
export function captionsFor(clip, { gameNumber = null, teamNames = {} } = {}) {
  const red  = teamNames.red  ?? 'Red';
  const blue = teamNames.blue ?? 'Blue';
  const stops = clip.povSchedule?.length
    ? clip.povSchedule
    : [{ atMs: 0, description: clip.description, type: clip.focalType, team: clip.focalTeam }];
  return stops.map(s => {
    const text  = (s.description ?? '').replace(/\bRed\b/g, red).replace(/\bBlue\b/g, blue);
    const type  = EVENT_LABEL[s.type] ?? s.type ?? 'Highlight';
    const label = gameNumber != null ? `Game ${gameNumber} · ${type}` : type;
    const team  = s.team === 1 ? 'red' : s.team === 2 ? 'blue' : null;
    return { atSec: (s.atMs ?? 0) / 1000, label, text, team };
  });
}

export function renderCaptionPng(pngPath, caption) {
  execFileSync('python3', [CARDS_PY, 'caption', pngPath, JSON.stringify(caption)]);
  return pngPath;
}

// Overlay the badges onto the clip and normalise to 30 fps (MediaRecorder output is VFR).
// items: [{ png, atSec }] — each badge slides in at atSec, holds, and fades out.
export function burnCaptions(clipPath, items, outPath) {
  const { x, y, delaySec, fadeInSec, holdSec, fadeOutSec } = CAPTION;
  const lifeSec = fadeInSec + holdSec + fadeOutSec;
  const inputs  = ['-i', clipPath];
  const filters = ['[0:v]fps=30,setpts=PTS-STARTPTS[v0]'];
  items.forEach((it, i) => {
    const start  = +(it.atSec + delaySec).toFixed(3);
    const slideX = `${x}-28*(1-min(1,max(0,(t-${start})/${fadeInSec})))`;
    inputs.push('-loop', '1', '-framerate', '30', '-t', String(lifeSec + 0.1), '-i', it.png);
    filters.push(
      `[${i + 1}:v]format=rgba,fade=t=in:st=0:d=${fadeInSec}:alpha=1,` +
      `fade=t=out:st=${fadeInSec + holdSec}:d=${fadeOutSec}:alpha=1,setpts=PTS+${start}/TB[c${i}]`,
      `[v${i}][c${i}]overlay=x='${slideX}':y=${y}:eof_action=pass:enable='between(t,${start},${start + lifeSec})'[v${i + 1}]`,
    );
  });
  execFileSync('ffmpeg', [
    '-y', ...inputs,
    '-filter_complex', filters.join(';'), '-map', `[v${items.length}]`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-an', outPath,
  ]);
  return outPath;
}
