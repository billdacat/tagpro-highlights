import { writeFileSync } from 'fs';
import { resolve } from 'path';

// Writes a clip manifest JSON that downstream renderers (Playwright, FFmpeg) consume.
export function exportManifest({ clips, meta, playerIndex, gameStartMs, outPath }) {
  const teams = meta?.teams ?? {};
  const players = Object.values(playerIndex).map(p => ({
    id: p.id,
    name: p.name,
    team: p.team,
    teamName: p.team === 1 ? 'Red' : 'Blue',
  }));

  const manifest = {
    version: 1,
    game: {
      uuid: meta?.uuid,
      gameId: meta?.gameId,
      map: meta?.mapName,
      server: meta?.serverName,
      date: meta?.started ? new Date(meta.started).toISOString() : null,
      durationMs: meta?.duration,
      gameStartMs,
      finalScore: { red: teams.red?.score ?? 0, blue: teams.blue?.score ?? 0 },
      winner: teams.red?.score > teams.blue?.score ? 'Red' : 'Blue',
    },
    players,
    clips: clips.map(clip => ({
      index: clip.index,
      startMs: clip.startMs,
      endMs: clip.endMs,
      durationMs: clip.endMs - clip.startMs,
      score: clip.score,
      focalType: clip.focalType,
      description: clip.description,
      scoreAtClip: clip.scoreAtClip,
      players: clip.players,
    })),
  };

  const resolved = resolve(outPath);
  writeFileSync(resolved, JSON.stringify(manifest, null, 2));
  return resolved;
}
