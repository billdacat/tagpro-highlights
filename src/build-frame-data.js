// Builds per-frame render state for a clip by interpolating over NDJSON p events.
// Returns a compact JSON-serialisable object consumed by the HTML renderer.

const FPS = 30;
const MS_PER_FRAME = 1000 / FPS;

// px coords in game space = rx * 100, ry * 100
// Game world: ~0–1400 × 0–1000 px (based on observed rx/ry ranges)
const COORD_SCALE = 100;

export function buildFrameData({ records, clip, allEvents, gameStartMs }) {
  const { startMs, endMs } = clip;
  const frameCount = Math.ceil((endMs - startMs) / MS_PER_FRAME);

  // ── 1. Extract map tiles (static, from first map event) ──
  let mapTiles = null;
  for (const [, type, data] of records) {
    if (type === 'map') { mapTiles = data.tiles; break; }
  }

  // ── 2. Build per-player state snapshots from p events ──
  // We track state up to (endMs) and keep history for the clip window.
  // playerTimeline[id] = sorted array of { ts, state }
  const playerTimeline = {}; // id → [{ ts, state }]
  const playerBase = {};     // id → latest full state (for initial values)

  for (const [ts, type, data] of records) {
    if (type !== 'p') continue;
    if (ts > endMs + 500) break; // no need to scan beyond clip

    for (const update of data) {
      const id = update.id;
      playerBase[id] = { ...playerBase[id], ...update };

      if (ts >= startMs - 500 && ts <= endMs + 500) {
        if (!playerTimeline[id]) playerTimeline[id] = [];
        playerTimeline[id].push({ ts, state: { ...playerBase[id] } });
      }
    }
  }

  // ── 3. Pre-collect captions for each frame ──
  // An event caption shows for 3 seconds after the event
  const CAPTION_DURATION_MS = 3000;
  const clipEvents = allEvents.filter(
    e => e.ts >= startMs && e.ts <= endMs && ['capture', 'return', 'tag'].includes(e.type)
  );

  // ── 4. Score timeline (track from score events) ──
  const scoreTimeline = []; // [{ ts, r, b }]
  for (const [ts, type, data] of records) {
    if (type === 'score') scoreTimeline.push({ ts, r: data.r, b: data.b });
  }

  // ── 5. Build frames ──
  const frames = [];
  for (let f = 0; f < frameCount; f++) {
    const frameTs = startMs + f * MS_PER_FRAME;

    // Score at this frame
    const scoreSnap = scoreTimeline.filter(s => s.ts <= frameTs).at(-1) ?? { r: 0, b: 0 };

    // Active caption
    const activeEvent = clipEvents
      .filter(e => e.ts <= frameTs && e.ts > frameTs - CAPTION_DURATION_MS)
      .at(-1);
    const caption = activeEvent ? describeEvent(activeEvent) : null;

    // Player states at this frame (latest update ≤ frameTs)
    const players = [];
    for (const [id, timeline] of Object.entries(playerTimeline)) {
      const snap = timeline.filter(s => s.ts <= frameTs).at(-1);
      if (!snap) continue;
      const s = snap.state;
      players.push({
        id: Number(id),
        team: s.team,
        // API: rx = x/100; center of ball = x+20, y+20 (ball occupies 40×40px tile)
        x: (s.rx ?? 0) * COORD_SCALE + 20,
        y: (s.ry ?? 0) * COORD_SCALE + 20,
        dead: !!s.dead,
        flag: s.flag ?? null,
        name: s.name ?? `P${id}`,
      });
    }

    frames.push({
      t: Math.round(frameTs - startMs),
      sc: [scoreSnap.r, scoreSnap.b],
      pl: players,
      cap: caption,
    });
  }

  return {
    map: { tiles: mapTiles, w: mapTiles?.[0]?.length ?? 27, h: mapTiles?.length ?? 37 },
    fps: FPS,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    frames,
  };
}

function describeEvent(e) {
  const team = e.team === 1 ? 'Red' : 'Blue';
  switch (e.type) {
    case 'capture': return `${e.playerName} caps for ${team}!`;
    case 'return':  return `${e.playerName} returns the flag`;
    case 'tag':     return `${e.playerName} tags an opponent`;
    default:        return `${e.playerName} — ${e.type}`;
  }
}
