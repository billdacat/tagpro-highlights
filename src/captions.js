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

// Build the caption for a clip.  Team words in the scorer's description ("Red"/"Blue")
// are swapped for the team names the server recorded, which match the on-screen score bar.
export function captionFor(clip, { gameNumber = null, teamNames = {} } = {}) {
  const red  = teamNames.red  ?? 'Red';
  const blue = teamNames.blue ?? 'Blue';
  const text = (clip.description ?? '')
    .replace(/\bRed\b/g, red)
    .replace(/\bBlue\b/g, blue);
  const type  = EVENT_LABEL[clip.focalType] ?? clip.focalType ?? 'Highlight';
  const label = gameNumber != null ? `Game ${gameNumber} · ${type}` : type;
  const team  = clip.focalTeam === 1 ? 'red' : clip.focalTeam === 2 ? 'blue' : null;
  return { label, text, team };
}

export function renderCaptionPng(pngPath, caption) {
  execFileSync('python3', [CARDS_PY, 'caption', pngPath, JSON.stringify(caption)]);
  return pngPath;
}

// Overlay the badge onto the clip and normalise to 30 fps (MediaRecorder output is VFR).
export function burnCaption(clipPath, pngPath, outPath) {
  const { x, y, delaySec, fadeInSec, holdSec, fadeOutSec } = CAPTION;
  const endSec       = delaySec + fadeInSec + holdSec + fadeOutSec;
  const fadeOutStart = endSec - fadeOutSec;
  const slideX       = `${x}-28*(1-min(1,max(0,(t-${delaySec})/${fadeInSec})))`;
  const filter = [
    `[0:v]fps=30,setpts=PTS-STARTPTS[base]`,
    `[1:v]format=rgba,fade=t=in:st=${delaySec}:d=${fadeInSec}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeOutSec}:alpha=1[cap]`,
    `[base][cap]overlay=x='${slideX}':y=${y}:eof_action=pass[v]`,
  ].join(';');
  execFileSync('ffmpeg', [
    '-y', '-i', clipPath,
    '-loop', '1', '-framerate', '30', '-t', String(endSec + 0.1), '-i', pngPath,
    '-filter_complex', filter, '-map', '[v]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-an', outPath,
  ]);
  return outPath;
}
