import { parseReplay } from './parse-replay.js';
import { scoreHighlights } from './score-highlights.js';
import { exportManifest } from './export-manifest.js';

const filePath = process.argv[2] ?? `${process.env.HOME}/Downloads/tagpro-bwjtsdpz-rnfstdli.billdacat.ndjson`;

console.log(`\nTagPro Highlight Finder`);
console.log('='.repeat(50));
console.log(`File: ${filePath}`);

console.log('\nParsing replay...');
const { meta, events, playerIndex, gameStartMs } = await parseReplay(filePath);

if (meta) {
  const teams = meta.teams ?? {};
  console.log(`\nMatch: ${meta.mapName} — ${meta.serverName}`);
  console.log(`  Red ${teams.red?.score ?? '?'} – Blue ${teams.blue?.score ?? '?'}`);
  console.log(`  Duration: ${(meta.duration / 60000).toFixed(1)} min`);
  console.log(`  Players: ${Object.values(playerIndex).map(p => `${p.name}(${p.team===1?'R':'B'})`).join(', ')}`);
}

console.log(`\nEvents decoded: ${events.length}`);
const byType = {};
for (const e of events) byType[e.type] = (byType[e.type] ?? 0) + 1;
for (const [t, c] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t.padEnd(12)} ${c}`);
}

console.log('\nScoring highlights...');
const highlights = scoreHighlights({ events, playerIndex, meta, gameStartMs });

console.log(`\n${'='.repeat(50)}`);
console.log(`TOP HIGHLIGHTS (${highlights.length} clips)`);
console.log('='.repeat(50));

for (const clip of highlights) {
  console.log(`\n[Clip ${clip.index}] ${clip.start} – ${clip.end}  (score: ${clip.score})`);
  console.log(`  ${clip.description}`);
  console.log(`  Score at clip: Red ${clip.scoreAtClip?.r ?? '?'} – Blue ${clip.scoreAtClip?.b ?? '?'}`);
  console.log(`  Players: ${clip.players.join(', ')}`);
  console.log('  Events:');
  for (const line of clip.events) console.log(`    ${line}`);
}

const manifestPath = exportManifest({
  clips: highlights,
  meta,
  playerIndex,
  gameStartMs,
  outPath: './highlight-manifest.json',
});
console.log(`\nManifest written to: ${manifestPath}`);
console.log('Done.');
