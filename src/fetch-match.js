import fetch from 'node-fetch';

export async function fetchMatch(matchId) {
  const url = `https://tagpro.eu/data/?match=${matchId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch match ${matchId}: ${res.status}`);
  return res.json();
}
