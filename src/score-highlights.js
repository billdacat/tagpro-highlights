const EVENT_SCORES = {
  capture: 20,
  return:  3,
  grab:    1,
  tag:     2,
  drop:    1,
};

const PRE_RADIUS_MS  = 8000;
const POST_RADIUS_MS = 2000;
const MERGE_GAP_MS   = 2000;
const MIN_NON_CAP_SCORE = 5; // non-cap windows must clear this to be included

export function scoreHighlights({ events, playerIndex, meta, gameStartMs, actualDurationMs, maxNonCapClips = 5 }) {
  const regulationMs   = typeof meta?.duration === 'number' ? meta.duration : null;
  const gameDurationMs = actualDurationMs ?? regulationMs ?? Infinity;
  const scored = events.filter(e => EVENT_SCORES[e.type] > 0);
  if (scored.length === 0) return [];

  // ── Pre-computation ────────────────────────────────────────────────────────

  // How each grab resolved: hold duration and whether it ended in a cap.
  // Used to penalise panic grabs (grabbed and immediately returned/popped).
  const grabOutcome = new Map(); // grab.ts → { holdMs, capped }
  const inFlight = {};           // playerId → ts of their active grab
  for (const e of events) {
    if (e.type === 'grab') {
      inFlight[e.playerId] = e.ts;
    } else if ((e.type === 'capture' || e.type === 'drop') && inFlight[e.playerId] != null) {
      grabOutcome.set(inFlight[e.playerId], {
        holdMs: e.ts - inFlight[e.playerId],
        capped: e.type === 'capture',
      });
      delete inFlight[e.playerId];
    }
  }

  // How long each capper carried the flag before scoring.
  // A long carry means the player ran the flag across the map — more exciting.
  const carryMs = new Map(); // capture.ts → carry duration in ms
  const lastGrab = {};
  for (const e of events) {
    if (e.type === 'grab') lastGrab[e.playerId] = e.ts;
    if (e.type === 'capture' && lastGrab[e.playerId] != null)
      carryMs.set(e.ts, e.ts - lastGrab[e.playerId]);
  }

  // ── Build candidates ───────────────────────────────────────────────────────

  const candidates = scored.map(focal => {
    const start = Math.max(0, focal.gameTime - PRE_RADIUS_MS);
    const end   = Math.min(gameDurationMs, focal.gameTime + POST_RADIUS_MS);

    const windowEvents = scored.filter(e => e.gameTime >= start && e.gameTime <= end);
    let totalScore = windowEvents.reduce((s, e) => s + (EVENT_SCORES[e.type] ?? 0), 0);

    // Penalty: grabs that were returned/popped within 3.5 s without capping.
    // These are panic grabs — they inflate event counts without adding drama.
    for (const e of windowEvents) {
      if (e.type !== 'grab') continue;
      const outcome = grabOutcome.get(e.ts);
      if (outcome && !outcome.capped && outcome.holdMs < 3500) totalScore -= 2;
    }

    // Bonus: cap with a genuine carry (player held flag ≥ 5 s = ran it across the map).
    if (focal.type === 'capture') {
      const carry = carryMs.get(focal.ts);
      if (carry != null && carry >= 5000) totalScore += 5;
    }

    // Bonus: captures that change or tie the lead.
    for (const cap of windowEvents.filter(e => e.type === 'capture')) {
      const { r, b } = cap.score;
      const mine = cap.team === 1 ? r : b;
      const theirs = cap.team === 1 ? b : r;
      if (mine === theirs)    totalScore += 5; // tie game
      else if (mine > theirs) totalScore += 3; // take the lead
    }

    // Overtime: a cap past regulation ends the game — always rank first.
    if (regulationMs !== null && focal.type === 'capture' && focal.gameTime > regulationMs) {
      totalScore += 25;
    }

    const headline = windowEvents.length > 0
      ? windowEvents.reduce((best, e) =>
          (EVENT_SCORES[e.type] ?? 0) > (EVENT_SCORES[best.type] ?? 0) ? e : best)
      : focal;

    return {
      focal, headline, start, end, totalScore,
      hasCapture:    focal.type === 'capture',
      players:       [...new Set(windowEvents.map(e => e.playerName).filter(Boolean))],
      windowEvents,
      scoreAtClip:   windowEvents.at(-1)?.score ?? focal.score,
    };
  });

  // ── Merge adjacent windows ─────────────────────────────────────────────────
  // Cap candidates merge only with other cap candidates, and non-cap candidates
  // merge only with each other.  Mixing the two causes a cascade: a return or
  // grab between two distant caps bridges their windows and collapses all caps
  // into one enormous clip.  Separate passes prevent that.

  function mergePass(list) {
    const out = [];
    for (const c of list.slice().sort((a, b) => a.start - b.start)) {
      const prev = out[out.length - 1];
      if (prev && c.start <= prev.end + MERGE_GAP_MS) {
        prev.end         = Math.max(prev.end, c.end);
        prev.totalScore += c.totalScore;
        prev.hasCapture  = prev.hasCapture || c.hasCapture;
        const seen = new Set(prev.windowEvents.map(e => e.ts));
        for (const e of c.windowEvents) if (!seen.has(e.ts)) prev.windowEvents.push(e);
        prev.windowEvents.sort((a, b) => a.ts - b.ts);
        prev.players = [...new Set([...prev.players, ...c.players])];
        prev.headline = prev.windowEvents
          .filter(e => EVENT_SCORES[e.type] > 0)
          .reduce((best, e) =>
            (EVENT_SCORES[e.type] ?? 0) > (EVENT_SCORES[best.type] ?? 0) ? e : best);
      } else {
        out.push({ ...c, windowEvents: [...c.windowEvents], players: [...c.players] });
      }
    }
    return out;
  }

  const mergedCaps  = mergePass(candidates.filter(c =>  c.hasCapture));
  const mergedOther = mergePass(candidates.filter(c => !c.hasCapture));

  // ── Selection ──────────────────────────────────────────────────────────────
  // Every cap window is guaranteed to appear — no cap is ever skipped.
  // Non-cap windows are added by score (descending) up to maxNonCapClips.

  const capClips    = mergedCaps;
  const nonCapClips = mergedOther
    .filter(c => c.totalScore >= MIN_NON_CAP_SCORE)
    .sort((a, b) => b.totalScore - a.totalScore);

  const selected = [...capClips];
  let nonCapAdded = 0;

  for (const c of nonCapClips) {
    if (nonCapAdded >= maxNonCapClips) break;
    const overlaps = selected.some(
      s => c.start < s.end + MERGE_GAP_MS && c.end > s.start - MERGE_GAP_MS
    );
    if (!overlaps) { selected.push(c); nonCapAdded++; }
  }

  selected.sort((a, b) => a.start - b.start);

  return selected.map((clip, i) => ({
    index:       i + 1,
    start:       fmtMs(clip.start),
    end:         fmtMs(clip.end),
    startMs:     clip.start,
    endMs:       clip.end,
    score:       clip.totalScore,
    focalType:   clip.headline.type,
    focalPlayer: clip.focal.playerName,
    players:     clip.players,
    scoreAtClip: clip.scoreAtClip,
    description: describe(clip.headline),
    events: clip.windowEvents.map(e =>
      `${fmtMs(e.gameTime).padEnd(6)} ${e.type.padEnd(10)} ${e.playerName}`
    ),
  }));
}

function fmtMs(ms) {
  if (ms < 0) ms = 0;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function describe(event) {
  const team = event.team === 1 ? 'Red' : 'Blue';
  switch (event.type) {
    case 'capture':
      return `${event.playerName} caps for ${team}! (cap #${event.data?.captureNum})`;
    case 'return':
      return `${event.playerName} returns the flag${event.data?.withTag ? ' + tag' : ''}`;
    case 'grab':
      return `${event.playerName} grabs the ${event.team === 1 ? 'Blue' : 'Red'} flag`;
    case 'tag':
      return `${event.playerName} tags an opponent`;
    case 'drop':
      return `${event.playerName} ${event.data?.wasPopped ? 'gets popped' : 'drops the flag'}`;
    default:
      return `${event.playerName} — ${event.type}`;
  }
}
