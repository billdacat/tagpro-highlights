const EVENT_SCORES = {
  capture: 20,
  return:  3,
  grab:    1,
  tag:     2,
  drop:    1,
};

const PRE_RADIUS_MS  = 8000;
const POST_RADIUS_MS = 2000;
const POST_CAP_RADIUS_MS    = 1000;  // a cap needs less tail: the play is over once the score ticks
const POV_HOLD_AFTER_CAP_MS = 1000;  // multi-cap clips: stay on a capper this long before moving on
const MERGE_GAP_MS   = 2000;
const MIN_NON_CAP_SCORE = 5; // non-cap windows must clear this to be included
const LONG_CARRY_MS  = 6000; // a flag carry this long that did not score is a near-miss worth showing

export function scoreHighlights({ events, playerIndex, meta, gameStartMs, actualDurationMs, maxNonCapClips = 30 }) {
  const regulationMs   = typeof meta?.duration === 'number' ? meta.duration : null;
  const gameDurationMs = actualDurationMs ?? regulationMs ?? Infinity;
  const scored = events.filter(e => EVENT_SCORES[e.type] > 0);
  if (scored.length === 0) return [];

  // ── Pre-computation ────────────────────────────────────────────────────────

  // How each grab resolved: hold duration and whether it ended in a cap.  Used to
  // penalise panic grabs, to score long carries, and to rate returns by what they stopped.
  const grabOutcome = new Map(); // grab.ts → { holdMs, capped }
  const dropsAt     = new Map(); // ts → [{ team, playerName, holdMs, wasPopped }] for drops at that instant
  const inFlight    = {};        // playerId → ts of their active grab
  for (const e of events) {
    if (e.type === 'grab') {
      inFlight[e.playerId] = e.ts;
    } else if ((e.type === 'capture' || e.type === 'drop') && inFlight[e.playerId] != null) {
      const holdMs = e.ts - inFlight[e.playerId];
      grabOutcome.set(inFlight[e.playerId], { holdMs, capped: e.type === 'capture' });
      if (e.type === 'drop') {
        if (!dropsAt.has(e.ts)) dropsAt.set(e.ts, []);
        dropsAt.get(e.ts).push({ team: e.team, playerName: e.playerName, holdMs, wasPopped: !!e.data?.wasPopped, event: e });
      }
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

  // A clip window around a focal event: everything scored inside it, with the
  // panic-grab penalty applied.  The focal event is also the headline, so the
  // camera and caption follow the player who made the play.
  const windowAt = (focal, start, end) => {
    const windowEvents = scored.filter(e => e.gameTime >= start && e.gameTime <= end);
    let totalScore = windowEvents.reduce((s, e) => s + (EVENT_SCORES[e.type] ?? 0), 0);
    for (const e of windowEvents) {
      if (e.type !== 'grab') continue;
      const outcome = grabOutcome.get(e.ts);
      if (outcome && !outcome.capped && outcome.holdMs < 3500) totalScore -= 2;
    }
    return {
      focal, headline: focal, start, end, totalScore, windowEvents,
      hasCapture:  focal.type === 'capture',
      players:     [...new Set(windowEvents.map(e => e.playerName).filter(Boolean))],
      scoreAtClip: windowEvents.at(-1)?.score ?? focal.score,
    };
  };

  // ── Capture windows ────────────────────────────────────────────────────────

  const capCandidates = scored.filter(e => e.type === 'capture').map(focal => {
    const c = windowAt(focal,
      Math.max(0, focal.gameTime - PRE_RADIUS_MS),
      Math.min(gameDurationMs, focal.gameTime + POST_CAP_RADIUS_MS));

    // Bonus: cap with a genuine carry (player held flag ≥ 5 s = ran it across the map).
    const carry = carryMs.get(focal.ts);
    if (carry != null && carry >= 5000) c.totalScore += 5;

    // Bonus: captures that change or tie the lead.
    for (const cap of c.windowEvents.filter(e => e.type === 'capture')) {
      const { r, b } = cap.score;
      const mine = cap.team === 1 ? r : b;
      const theirs = cap.team === 1 ? b : r;
      if (mine === theirs)    c.totalScore += 5; // tie game
      else if (mine > theirs) c.totalScore += 3; // take the lead
    }

    // Overtime: a cap past regulation ends the game — always rank first.
    if (regulationMs !== null && focal.gameTime > regulationMs) c.totalScore += 25;

    // Headline: the highest-scoring event in the window (a capture).
    c.headline = c.windowEvents.reduce((best, e) =>
      (EVENT_SCORES[e.type] ?? 0) > (EVENT_SCORES[best.type] ?? 0) ? e : best, focal);
    return c;
  });

  // ── Filler moments (non-capture plays) ─────────────────────────────────────
  // Each moment is its own short window; they are never chained together, so a
  // busy game yields many usable clips rather than one unusable blob.
  //   • returns — rated by what they stopped: a quick return on a fresh grab, or
  //     ending a long carry that was heading for a cap, scores extra
  //   • long carries that did not score — the near-misses

  const fillerCandidates = [];

  for (const r of scored.filter(e => e.type === 'return')) {
    const c = windowAt(r,
      Math.max(0, r.gameTime - PRE_RADIUS_MS),
      Math.min(gameDurationMs, r.gameTime + POST_RADIUS_MS));
    const stopped = (dropsAt.get(r.ts) ?? []).filter(d => d.team !== r.team);
    const holdMs  = stopped.length ? Math.max(...stopped.map(d => d.holdMs)) : null;
    if (holdMs != null && holdMs <= 3000) c.totalScore += 3;     // quick return
    if (holdMs != null && holdMs >= 8000) c.totalScore += 4;     // stopped a long carry
    if (r.data?.withTag) c.totalScore += 1;
    c.focal = c.headline = { ...r, data: { ...r.data, stoppedHoldMs: holdMs } };
    fillerCandidates.push(c);
  }

  for (const drops of dropsAt.values()) {
    for (const d of drops) {
      if (d.holdMs < LONG_CARRY_MS) continue;
      const focal = { ...d.event, type: 'carry', data: { holdMs: d.holdMs, wasPopped: d.wasPopped } };
      const c = windowAt(focal,
        Math.max(0, focal.gameTime - Math.min(d.holdMs + 2000, 14000)),
        Math.min(gameDurationMs, focal.gameTime + POST_RADIUS_MS));
      c.totalScore += 6 + Math.floor(d.holdMs / 2000);
      fillerCandidates.push(c);
    }
  }

  // ── Merge adjacent capture windows ─────────────────────────────────────────
  // Caps close together share one clip (the camera moves between cappers).

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

  const capClips = mergePass(capCandidates);

  // ── Selection ──────────────────────────────────────────────────────────────
  // Every cap clip is kept — no cap is ever skipped.  Filler moments are taken
  // best-first, skipping any that overlap a cap clip or a better filler clip,
  // up to maxNonCapClips.  The reel planner decides how many of them to use.

  const taken  = [...capClips];
  const filler = [];
  for (const c of fillerCandidates.filter(c => c.totalScore >= MIN_NON_CAP_SCORE).sort((a, b) => b.totalScore - a.totalScore)) {
    if (filler.length >= maxNonCapClips) break;
    const overlaps = taken.some(s => c.start < s.end + MERGE_GAP_MS && c.end > s.start - MERGE_GAP_MS);
    if (!overlaps) { filler.push(c); taken.push(c); }
  }

  const selected = [...capClips, ...filler].sort((a, b) => a.start - b.start);

  return selected.map((clip, i) => {
    const povSchedule = buildPovSchedule(clip);
    return {
    index:       i + 1,
    start:       fmtMs(clip.start),
    end:         fmtMs(clip.end),
    startMs:     clip.start,
    endMs:       clip.end,
    score:       clip.totalScore,
    focalType:   clip.headline.type,
    focalTeam:   clip.headline.team,     // 1 = red, 2 = blue
    focalPlayer: povSchedule[0].player,
    povSchedule,
    players:     clip.players,
    scoreAtClip: clip.scoreAtClip,
    description: describe(clip.headline),
    events: clip.windowEvents.map(e =>
      `${fmtMs(e.gameTime).padEnd(6)} ${e.type.padEnd(10)} ${e.playerName}`
    ),
    };
  });
}

// Who the camera follows, and when it moves.  A clip that holds several captures
// follows each capper in turn: it stays on one until shortly after their cap, then
// moves to the next.  Any other clip follows the player who makes its headline play,
// which is also the player its caption names.  atMs is relative to the clip start.
function buildPovSchedule(clip) {
  const caps  = clip.windowEvents.filter(e => e.type === 'capture');
  const stops = caps.length ? caps : [clip.headline];
  const schedule = [];
  stops.forEach((e, i) => {
    const prev = stops[i - 1];
    if (prev && prev.playerName === e.playerName) return;   // camera is already on them
    let atMs = 0;
    if (prev) {
      const gap = e.gameTime - prev.gameTime;
      atMs = Math.round(prev.gameTime - clip.start + Math.min(POV_HOLD_AFTER_CAP_MS, gap / 2));
    }
    schedule.push({ atMs, player: e.playerName, team: e.team, type: e.type, description: describe(e) });
  });
  return schedule;
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
    case 'return': {
      const hold = event.data?.stoppedHoldMs;
      const how  = hold != null && hold <= 3000 ? 'quick return' : hold != null && hold >= 8000 ? 'big return' : 'return';
      return `${event.playerName} with the ${how}${event.data?.withTag ? ' + tag' : ''}`;
    }
    case 'carry': {
      const secs = Math.round((event.data?.holdMs ?? 0) / 1000);
      return `${event.playerName} carries for ${secs}s before ${event.data?.wasPopped ? 'getting popped' : 'dropping it'}`;
    }
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
