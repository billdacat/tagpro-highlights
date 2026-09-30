// End-of-game scoreboard cards: a team comparison card and a full box score.
// Rendering is done by src/scoreboard_cards.py (Pillow).

import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir     = dirname(fileURLToPath(import.meta.url));
const CARDS_PY  = resolve(__dir, 'scoreboard_cards.py');
const LOGO_PATH = resolve(__dir, '../tagprologo.png');

const STAT_KEYS = {
  caps: 's-captures', grabs: 's-grabs', hold: 's-hold', returns: 's-returns', tags: 's-tags',
  prevent: 's-prevent', pups: 's-powerups', pops: 's-pops', drops: 's-drops', score: 'score',
};

// One row per person.  A player who reconnects gets a new id each time, so roster
// entries are merged by account (or name) and their stats added up.
export function mergePlayers(meta, playerStats) {
  const byPerson = new Map();
  for (const rp of meta?.players ?? []) {
    if (rp.team !== 1 && rp.team !== 2) continue;
    const s    = playerStats[rp.id] ?? {};
    const name = rp.displayName ?? s.name ?? `Player${rp.id}`;
    const key  = `${rp.team}:${rp.userId ?? name}`;
    const row  = byPerson.get(key) ?? { name, team: rp.team, ...Object.fromEntries(Object.keys(STAT_KEYS).map(k => [k, 0])) };
    for (const [k, src] of Object.entries(STAT_KEYS)) row[k] += s[src] ?? 0;
    byPerson.set(key, row);
  }
  return [...byPerson.values()];
}

// game: what parseReplay returns.
// extras: { teamNames: { red, blue }, teamLogos: { red, blue }, overtime, gameNumber, totalGames, label, source }
export function buildScoreboardData(game, extras = {}) {
  const { meta, playerStats, finalScore } = game;
  const players = mergePlayers(meta, playerStats);
  const team = (n, side) => ({
    abbr:    meta?.teams?.[side]?.name ?? side.toUpperCase(),
    name:    extras.teamNames?.[side] ?? meta?.teams?.[side]?.name ?? side,
    logo:    extras.teamLogos?.[side] ?? null,
    score:   finalScore?.[side[0]] ?? 0,
    players: players.filter(p => p.team === n).sort((a, b) => b.score - a.score || b.caps - a.caps),
  });
  const durationMs = meta?.duration ?? game.actualDurationMs ?? 0;
  return {
    red:  team(1, 'red'),
    blue: team(2, 'blue'),
    overtime:    extras.overtime ?? durationMs > 601_500,
    durationSec: Math.round(durationMs / 1000),
    mapName:     meta?.mapName ?? '',
    gameNumber:  extras.gameNumber ?? null,
    totalGames:  extras.totalGames ?? null,
    label:       extras.label ?? '',
    source:      extras.source ?? '',
  };
}

const render = (mode, pngPath, data) => {
  execFileSync('python3', [CARDS_PY, mode, pngPath, JSON.stringify(data), LOGO_PATH]);
  return pngPath;
};
export const renderCompareCard  = (pngPath, data) => render('compare', pngPath, data);
export const renderBoxScoreCard = (pngPath, data) => render('boxscore', pngPath, data);

// Still card → fixed-length 1280x720 clip that can be stitched with the gameplay.
function toClip(pngPath, mp4Path, seconds) {
  execFileSync('ffmpeg', [
    '-y', '-loop', '1', '-i', pngPath,
    '-t', String(seconds), '-r', '30',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-vf', 'scale=1280:720', '-an', mp4Path,
  ]);
  return mp4Path;
}
export const makeCompareCard  = (pngPath, mp4Path, data, seconds) => toClip(renderCompareCard(pngPath, data), mp4Path, seconds);
export const makeBoxScoreCard = (pngPath, mp4Path, data, seconds) => toClip(renderBoxScoreCard(pngPath, data), mp4Path, seconds);
