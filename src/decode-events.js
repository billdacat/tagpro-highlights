import { BitReader } from './bit-reader.js';

const FLAG = { none: 0, opponent: 1, opponentPotato: 2, neutral: 3, neutralPotato: 4, temporary: 5 };
const TEAM = { none: 0, red: 1, blue: 2 };
const POWER = { jukeJuice: 1, rollingBomb: 2, tagPro: 4, topSpeed: 8 };

// Decodes the base64 events blob for a single player into an array of game events.
// Returns: Array<{ frame, type, data }>
export function decodePlayerEvents(base64, playerName, team) {
  const buf = Buffer.from(base64, 'base64');
  const reader = new BitReader(buf);
  const events = [];

  let frame = 0;
  let currentFlag = FLAG.none;
  let currentTeam = team;
  let powers = 0;
  let preventing = false;

  while (!reader.done) {
    // Team status
    const teamChanged = reader.readBool();
    if (teamChanged) {
      const left = reader.readBool();
      if (!left) {
        currentTeam = reader.readFixed(2);
      } else {
        currentTeam = TEAM.none;
      }
    }

    // Drop / pop
    const dropPop = reader.readBool();
    if (dropPop) {
      if (currentFlag !== FLAG.none) {
        events.push({ frame, type: 'drop', data: { player: playerName, flag: currentFlag } });
        currentFlag = FLAG.none;
      } else {
        events.push({ frame, type: 'pop', data: { player: playerName } });
      }
    }

    // Returns
    const returns = reader.readTally();
    for (let i = 0; i < returns; i++) {
      events.push({ frame, type: 'return', data: { player: playerName, team: currentTeam } });
    }

    // Tags
    const tags = reader.readTally();
    for (let i = 0; i < tags; i++) {
      events.push({ frame, type: 'tag', data: { player: playerName, team: currentTeam } });
    }

    // Grab (only if not already holding a flag)
    const grab = currentFlag === FLAG.none && reader.readBool();
    if (grab) {
      events.push({ frame, type: 'grab', data: { player: playerName, team: currentTeam } });
    }

    // Captures
    const captures = reader.readTally();
    for (let i = 0; i < captures; i++) {
      events.push({ frame, type: 'capture', data: { player: playerName, team: currentTeam, flag: currentFlag } });
    }

    // Flag state update
    if (grab || captures > 0) {
      const keep = reader.readBool();
      if (keep) {
        currentFlag = reader.readFixed(2);
      } else {
        currentFlag = FLAG.none;
      }
    }

    // Powerups acquired
    const newPowerups = reader.readTally();
    for (let i = 0; i < newPowerups; i++) {
      events.push({ frame, type: 'powerup', data: { player: playerName } });
    }

    // Power toggles (4 bits: jukeJuice, rollingBomb, tagPro, topSpeed)
    for (const [name, bit] of Object.entries(POWER)) {
      const toggle = reader.readBool();
      if (toggle) {
        powers ^= bit;
        events.push({ frame, type: 'powerToggle', data: { player: playerName, power: name, active: !!(powers & bit) } });
      }
    }

    // State toggles
    const togglePrevent = reader.readBool();
    if (togglePrevent) preventing = !preventing;
    reader.readBool(); // toggleButton
    reader.readBool(); // toggleBlock

    // Time delta: frames since last event (footer value + 1)
    const delta = reader.readFooter() + 1;
    frame += delta;
  }

  return events;
}
