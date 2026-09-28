// Fetch an MLTP (mltp.gg) matchup and extract the tagpro.eu match ID for each game.
//
// The matchup page is a Next.js app; the server-rendered HTML embeds the matchup
// object inside React Server Component payloads (`self.__next_f.push([1, "..."])`).
// We unescape those payloads and pull the `"matchup":{...}` object out of them, so
// no browser is needed.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Accepts a bare matchup UUID or any mltp.gg matchup URL → UUID
export function parseMatchupId(input) {
  const m = String(input ?? '').match(UUID_RE);
  if (!m) throw new Error(`Not an MLTP matchup ID or URL: ${input}`);
  return m[0].toLowerCase();
}

export function matchupUrl(matchupId, tier) {
  const q = tier ? `?tier=${encodeURIComponent(tier)}` : '';
  return `https://www.mltp.gg/matchup/${matchupId}${q}`;
}

// Extract the JSON object that starts at `start` (which must point at '{') using
// bracket matching that respects string literals.
function sliceJsonObject(text, start) {
  let depth = 0, inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error('Unterminated JSON object in MLTP payload');
}

// Pull the raw matchup object out of the page HTML.
export function extractMatchupJson(html) {
  const pushRe = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  for (const m of html.matchAll(pushRe)) {
    let payload;
    try { payload = JSON.parse(`"${m[1]}"`); } catch { continue; }
    const key = '"matchup":';
    const at  = payload.indexOf(key);
    if (at === -1) continue;
    const objStart = payload.indexOf('{', at + key.length);
    if (objStart === -1) continue;
    return JSON.parse(sliceJsonObject(payload, objStart));
  }
  throw new Error('Could not find matchup data in the MLTP page (layout may have changed)');
}

const matchIdFromReplayUrl = url => String(url ?? '').match(/[?&]match=(\d+)/)?.[1] ?? null;

const team = t => t ? {
  id:           t.id ?? null,
  name:         t.name ?? '?',
  abbreviation: t.abbreviation ?? (t.name ?? '?').slice(0, 4).toUpperCase(),
  colorHex:     t.colorHex ?? null,
} : null;

// Normalise the raw matchup object into what the exporter needs.
export function normaliseMatchup(raw) {
  const games = (raw.games ?? [])
    .slice()
    .sort((a, b) => (a.gameNumber ?? 0) - (b.gameNumber ?? 0))
    .map(g => ({
      gameNumber: g.gameNumber,
      mapName:    g.mapName ?? '',
      score:      Array.isArray(g.score) ? g.score : null,   // [home, away]
      overtime:   !!g.overtime,
      status:     g.status ?? 'unknown',
      replayUrl:  g.replayUrl ?? null,
      matchId:    matchIdFromReplayUrl(g.replayUrl),
    }));

  return {
    matchupId:   raw.matchupId,
    tier:        raw.tierSlug ?? null,
    season:      raw.seasonNumber ?? null,
    week:        raw.weekNumber ?? null,
    scheduledAt: raw.scheduledAt ?? null,
    bestOf:      raw.bestOf ?? games.length,
    isPlayoff:   !!raw.isPlayoff,
    playoffRoundName: raw.playoffRoundName ?? null,
    home:        team(raw.homeTeam),
    away:        team(raw.awayTeam),
    seriesScore: Array.isArray(raw.seriesScore) ? raw.seriesScore : null,
    winner:      raw.winner ?? null,
    games,
  };
}

export async function fetchMatchup(input) {
  const matchupId = parseMatchupId(input);
  const tier      = String(input).match(/[?&]tier=([^&#]+)/)?.[1];
  const url       = matchupUrl(matchupId, tier);

  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (tagpro-highlights)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const html = await res.text();

  const matchup = normaliseMatchup(extractMatchupJson(html));
  matchup.url = url;
  return matchup;
}

// Human-readable one-liner, e.g. "MLTP Majors · Season 40 · Week 3"
export function describeMatchup(m) {
  const parts = ['MLTP'];
  if (m.tier)   parts.push(m.tier.charAt(0).toUpperCase() + m.tier.slice(1));
  if (m.season) parts.push(`Season ${m.season}`);
  if (m.isPlayoff && m.playoffRoundName) parts.push(m.playoffRoundName);
  else if (m.week) parts.push(`Week ${m.week}`);
  return parts.join(' · ');
}
