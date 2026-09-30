// Render the end-of-game scoreboard cards for one replay, without recording anything.
//
//   node src/preview-scoreboards.js <replay.ndjson> [--mltp=<matchup id|url> --game=N] [--out=DIR]
//
// With --mltp the cards use the matchup's full team names, league label, and overtime flag.

import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { parseReplay } from './parse-replay.js';
import { fetchMatchup, describeMatchup, downloadTeamLogos } from './mltp.js';
import { buildScoreboardData, renderCompareCard, renderBoxScoreCard } from './scoreboard-cards.js';

const flag = n => process.argv.find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const ndjson = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!ndjson) { console.error('usage: node src/preview-scoreboards.js <replay.ndjson> [--mltp=ID --game=N] [--out=DIR]'); process.exit(1); }

const game   = await parseReplay(ndjson);
const extras = {};
if (flag('mltp')) {
  const m  = await fetchMatchup(flag('mltp'));
  await downloadTeamLogos(m, resolve('./output/logos'));
  const n  = parseInt(flag('game') ?? '1');
  const mg = m.games.find(g => g.gameNumber === n);
  const teamOf = abbr => [m.home, m.away].find(t => t.abbreviation === abbr);
  const [red, blue] = [teamOf(game.meta?.teams?.red?.name), teamOf(game.meta?.teams?.blue?.name)];
  extras.teamNames  = { red: red?.name, blue: blue?.name };
  extras.teamLogos  = { red: red?.logoPath, blue: blue?.logoPath };
  extras.overtime   = mg?.overtime;
  extras.gameNumber = n;
  extras.totalGames = m.bestOf;
  extras.label      = describeMatchup(m);
  extras.source     = mg?.matchId ? `tagpro.eu #${mg.matchId}` : '';
}

const out  = resolve(flag('out') ?? './output/mockups');
mkdirSync(out, { recursive: true });
const data = buildScoreboardData(game, extras);
const tag  = extras.gameNumber ? `game${extras.gameNumber}-` : '';
console.log(renderCompareCard(`${out}/${tag}team-comparison.png`, data));
console.log(renderBoxScoreCard(`${out}/${tag}box-score.png`, data));
