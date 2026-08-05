// Generates all WAV voice lines for the TagPro VGS demo.
// Usage: node src/generate-audio.js
// Output: output/audio/*.wav

import { execSync } from 'child_process';
import { mkdirSync } from 'fs';
import { resolve } from 'path';

const OUT = resolve('./output/audio');
mkdirSync(OUT, { recursive: true });

// Each entry: { file, voice, phrase, rate?, atempo? }
// rate: words-per-minute passed to `say -r` (default ~175)
// atempo: ffmpeg atempo filter multiplier (>1 = faster)
const LINES = [
  // BilldaCat — Reed voice (natural US male), sped up
  { file: 'billdacat-attack',  voice: 'Reed (English (US))', phrase: 'I am attacking the flag!', rate: 200, atempo: 1.2 },
  { file: 'billdacat-woohoo',  voice: 'Reed (English (US))', phrase: 'Woo hoo!',                 rate: 200, atempo: 1.2 },
  { file: 'billdacat-gate',    voice: 'Reed (English (US))', phrase: 'Get the gate!',             rate: 200, atempo: 1.2 },

  // Cbad — Grandpa voice (deep, gruff)
  { file: 'cbad-handoff',      voice: 'Grandpa (English (US))', phrase: 'Handoff!',              rate: 180 },

  // Kobe Maybe — Zarvox (robotic, hilarious for "You idiots!")
  { file: 'kobemaybe-idiots',  voice: 'Zarvox',              phrase: 'You idiots!',              rate: 160 },
];

console.log('Generating VGS audio lines\n');

for (const line of LINES) {
  const aiff = `${OUT}/${line.file}.aiff`;
  const wav  = `${OUT}/${line.file}.wav`;

  process.stdout.write(`  ${line.file.padEnd(22)} `);
  try {
    const rateFlag = line.rate ? `-r ${line.rate}` : '';
    execSync(`say -v "${line.voice}" ${rateFlag} "${line.phrase}" -o "${aiff}"`, { stdio: 'pipe' });

    const aFilter = line.atempo && line.atempo !== 1
      ? `-filter:a "atempo=${line.atempo}"`
      : '';
    execSync(`ffmpeg -y -i "${aiff}" ${aFilter} "${wav}" 2>/dev/null`, { stdio: 'pipe' });
    execSync(`rm "${aiff}"`);
    console.log(`→ ${wav.split('/').pop()}`);
  } catch (err) {
    console.log(`FAILED: ${err.message.split('\n')[0]}`);
  }
}

console.log('\nDone.');
