// Title cards for multi-game highlight reels: series intro, per-game title, series final.
// Rendering is done by src/series_cards.py (Pillow); this wrapper turns the PNG into
// a fixed-length 1280x720 MP4 that can be stitched with the gameplay clips.

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir     = dirname(fileURLToPath(import.meta.url));
const CARDS_PY  = resolve(__dir, 'series_cards.py');
const LOGO_PATH = resolve(__dir, '../tagprologo.png');

export const CARD_SECONDS = { intro: 5, game: 4, final: 8 };

// rows: [{ gameNumber, score: [home, away] | null }] for every game in the series.
// Series score once all the given games are played.
export function seriesScoreAfter(rows) {
  return rows.reduce((s, r) => {
    if (r.score) {
      if (r.score[0] > r.score[1]) s[0]++;
      else if (r.score[1] > r.score[0]) s[1]++;
    }
    return s;
  }, [0, 0]);
}

// Series score going INTO a game: earlier games only.  A game's title card is shown
// before its clips, so it must never include that game's own result.
export function seriesScoreEntering(rows, gameNumber) {
  return seriesScoreAfter(rows.filter(r => r.gameNumber < gameNumber));
}

function renderCard(mode, pngPath, mp4Path, data, seconds) {
  execFileSync('python3', [CARDS_PY, mode, pngPath, JSON.stringify(data), LOGO_PATH]);
  execFileSync('ffmpeg', [
    '-y', '-loop', '1', '-i', pngPath,
    '-t', String(seconds), '-r', '30',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-vf', 'scale=1280:720', '-an', mp4Path,
  ]);
  return mp4Path;
}

// series: { label, home, away, bestOf, scheduledAt, footer }
export function makeSeriesIntroCard(pngPath, mp4Path, series) {
  return renderCard('intro', pngPath, mp4Path, series, CARD_SECONDS.intro);
}

// game: { gameNumber, totalGames, mapName, seriesScore: [home, away], colors: { home: 'red'|'blue', away }, home, away, footer }
export function makeGameTitleCard(pngPath, mp4Path, game) {
  return renderCard('game', pngPath, mp4Path, game, CARD_SECONDS.game);
}

// final: { home, away, seriesScore: [home, away], games: [{ gameNumber, mapName, score: [home, away], overtime }], footer }
export function makeSeriesFinalCard(pngPath, mp4Path, final) {
  return renderCard('final', pngPath, mp4Path, final, CARD_SECONDS.final);
}
