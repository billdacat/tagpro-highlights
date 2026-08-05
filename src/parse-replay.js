import { createReadStream } from 'fs';
import { createInterface } from 'readline';

// Parses a TagPro NDJSON replay file into structured game events.
// Each NDJSON line is [timestampMs, eventType, data].
// Returns: { meta, events, playerIndex }
export async function parseReplay(filePath) {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });

  const records = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }

  return extractEvents(records);
}

function extractEvents(records) {
  let meta = null;
  let gameStartMs = 0;
  let lastTs = 0;
  const playerIndex = {}; // id → { id, name, team, ... }
  const playerStats = {}; // id → { 's-grabs', 's-captures', etc. }
  const events = [];
  let score = { r: 0, b: 0 };

  for (const [ts, type, data] of records) {
    if (typeof ts === 'number' && ts > lastTs) lastTs = ts;
    switch (type) {
      case 'recorder-metadata':
        meta = data;
        break;

      case 'time':
        // state 3 = game in progress. data.time is current game-clock ms (countdown = 0–20000ms).
        // Flags go live at game-clock 20000ms; we want gameTime=0 at that moment.
        // gameStartMs = the recording ts when game-clock reaches 20000.
        if (data.state === 3 && gameStartMs === 0) {
          const COUNTDOWN_MS = 20000;
          gameStartMs = ts + (COUNTDOWN_MS - data.time);
        }
        break;

      case 'score':
        score = { r: data.r, b: data.b };
        break;

      case 'p':
        for (const update of data) {
          const id = update.id;
          const prev = playerStats[id] ?? {};

          // Register players on first full state update
          if (update.name && !playerIndex[id]) {
            playerIndex[id] = { id, name: update.name, team: update.team };
          }

          const gameTime = ts - gameStartMs;
          const player = playerIndex[id];

          // --- Grabs: flag changed from null/undefined to a value ---
          if (update.flag != null && (prev.flag == null || prev.flag === undefined)) {
            events.push({
              type: 'grab',
              ts,
              gameTime,
              playerId: id,
              playerName: player?.name ?? `Player${id}`,
              team: player?.team ?? update.team,
              score: { ...score },
              data: { flag: update.flag, clutch: !!update.clutchFlag },
            });
          }

          // --- Flag drops: flag changed to null (not from a capture) ---
          if (update.flag === null && prev.flag != null) {
            const isCapture = (update['s-captures'] ?? prev['s-captures'] ?? 0) > (prev['s-captures'] ?? 0);
            if (!isCapture) {
              events.push({
                type: 'drop',
                ts,
                gameTime,
                playerId: id,
                playerName: player?.name ?? `Player${id}`,
                team: player?.team ?? update.team,
                score: { ...score },
                data: { wasPopped: (update['s-pops'] ?? 0) > (prev['s-pops'] ?? 0) },
              });
            }
          }

          // --- Captures (s-captures increased) ---
          const prevCaps = prev['s-captures'] ?? 0;
          const newCaps = update['s-captures'] ?? prevCaps;
          if (newCaps > prevCaps) {
            events.push({
              type: 'capture',
              ts,
              gameTime,
              playerId: id,
              playerName: player?.name ?? `Player${id}`,
              team: player?.team ?? update.team,
              score: { ...score },
              data: { captureNum: newCaps, isClutch: !!prev.clutchFlag },
            });
          }

          // --- Returns (s-returns increased) ---
          const prevRet = prev['s-returns'] ?? 0;
          const newRet = update['s-returns'] ?? prevRet;
          if (newRet > prevRet) {
            events.push({
              type: 'return',
              ts,
              gameTime,
              playerId: id,
              playerName: player?.name ?? `Player${id}`,
              team: player?.team ?? update.team,
              score: { ...score },
              data: { withTag: (update['s-tags'] ?? 0) > (prev['s-tags'] ?? 0) },
            });
          }

          // --- Tags (s-tags increased, but not from a return with tag — avoid double-counting) ---
          const prevTags = prev['s-tags'] ?? 0;
          const newTags = update['s-tags'] ?? prevTags;
          if (newTags > prevTags && newRet <= prevRet) {
            events.push({
              type: 'tag',
              ts,
              gameTime,
              playerId: id,
              playerName: player?.name ?? `Player${id}`,
              team: player?.team ?? update.team,
              score: { ...score },
              data: { tagCount: newTags },
            });
          }

          // Merge update into tracked state
          playerStats[id] = { ...prev, ...update };
        }
        break;
    }
  }

  events.sort((a, b) => a.ts - b.ts);

  // Actual game duration from wall-clock timestamps, not meta.duration (which is the
  // scheduled regulation length and doesn't include overtime).
  const actualDurationMs = gameStartMs > 0 && lastTs > gameStartMs
    ? lastTs - gameStartMs
    : (meta?.duration ?? 0);

  return { meta, events, playerIndex, gameStartMs, playerStats, finalScore: score, actualDurationMs };
}
