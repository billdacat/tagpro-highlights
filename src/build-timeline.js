import { decodePlayerEvents } from './decode-events.js';

const FPS = 60;

// Merges all player event streams into a single sorted timeline.
// Returns: { events, players, meta }
export function buildTimeline(matchData) {
  const allEvents = [];
  const playerMap = {};

  for (const player of matchData.players) {
    playerMap[player.name] = { name: player.name, team: player.team, score: player.score };
    try {
      const events = decodePlayerEvents(player.events, player.name, player.team);
      allEvents.push(...events);
    } catch (e) {
      console.warn(`  Warning: failed to decode events for ${player.name}: ${e.message}`);
    }
  }

  allEvents.sort((a, b) => a.frame - b.frame);

  // Convert frames to seconds
  const timeline = allEvents.map(e => ({
    ...e,
    time: e.frame / FPS,
  }));

  return {
    events: timeline,
    players: playerMap,
    meta: {
      map: matchData.map?.name,
      duration: matchData.duration / FPS,
      date: new Date(matchData.date * 1000).toISOString(),
      teams: matchData.teams?.map(t => ({ name: t.name, score: t.score })),
      uuid: matchData.uuid,
    },
  };
}
