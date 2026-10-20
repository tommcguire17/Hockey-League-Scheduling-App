import type { Season, Game } from './schema.js';
import { gameWhen, PLAYOFF_TYPES } from './schema.js';
import type { LeagueManifest } from './manifest.js';

export interface StandingRow {
  teamId: string;
  teamName: string;
  divisionId: string;
  played: number;
  won: number;
  lost: number;
  tied: number;
  points: number;
  goalsFor: number;
  goalsAgainst: number;
  diff: number;
  /** Most recent first, newest result first: 'W' | 'L' | 'T'. */
  form: string[];
  rank: number;
}

/** A game counts once both scores are in. A 0-0 draw is a played game. */
export function isPlayed(g: Game): boolean {
  return g.homeGoals !== null && g.awayGoals !== null;
}

/**
 * Regular-season standings, one table per division.
 *
 * Ranking: points, then goal difference, then goals for, then head to head,
 * then team name, so the order is total and never depends on array order.
 */
export function standings(season: Season, m: LeagueManifest): StandingRow[] {
  const slotById = new Map(season.slots.map((s) => [s.id, s]));
  const rows = new Map<string, StandingRow>();
  for (const t of season.teams) {
    rows.set(t.id, {
      teamId: t.id, teamName: t.name, divisionId: t.divisionId,
      played: 0, won: 0, lost: 0, tied: 0, points: 0,
      goalsFor: 0, goalsAgainst: 0, diff: 0, form: [], rank: 0,
    });
  }

  const counted = season.games
    .filter((g) => !PLAYOFF_TYPES.has(g.type) && isPlayed(g) && g.homeTeamId && g.awayTeamId)
    .map((g) => ({ g, w: gameWhen(g, slotById) }))
    .sort((a, b) => ((a.w?.date ?? '') + (a.w?.start ?? ''))
      .localeCompare((b.w?.date ?? '') + (b.w?.start ?? '')));

  const h2h = new Map<string, number>();   // "a|b" -> a's points against b

  for (const { g } of counted) {
    const home = rows.get(g.homeTeamId!), away = rows.get(g.awayTeamId!);
    if (!home || !away) continue;
    const hg = g.homeGoals!, ag = g.awayGoals!;
    home.played++; away.played++;
    home.goalsFor += hg; home.goalsAgainst += ag;
    away.goalsFor += ag; away.goalsAgainst += hg;
    const add = (a: StandingRow, b: StandingRow, pts: number, mark: string) => {
      a.points += pts; a.form.unshift(mark);
      h2h.set(`${a.teamId}|${b.teamId}`, (h2h.get(`${a.teamId}|${b.teamId}`) ?? 0) + pts);
    };
    if (hg > ag) {
      home.won++; away.lost++;
      add(home, away, m.standings.winPoints, 'W');
      add(away, home, m.standings.lossPoints, 'L');
    } else if (ag > hg) {
      away.won++; home.lost++;
      add(away, home, m.standings.winPoints, 'W');
      add(home, away, m.standings.lossPoints, 'L');
    } else {
      home.tied++; away.tied++;
      add(home, away, m.standings.tiePoints, 'T');
      add(away, home, m.standings.tiePoints, 'T');
    }
  }

  const all = [...rows.values()];
  for (const r of all) r.diff = r.goalsFor - r.goalsAgainst;

  for (const d of season.divisions) {
    const inDiv = all.filter((r) => r.divisionId === d.id);
    inDiv.sort((a, b) =>
      b.points - a.points
      || b.diff - a.diff
      || b.goalsFor - a.goalsFor
      || (h2h.get(`${b.teamId}|${a.teamId}`) ?? 0) - (h2h.get(`${a.teamId}|${b.teamId}`) ?? 0)
      || a.teamName.localeCompare(b.teamName));
    inDiv.forEach((r, i) => { r.rank = i + 1; });
  }

  const order = new Map(season.divisions.map((d, i) => [d.id, i]));
  return all.sort((a, b) =>
    (order.get(a.divisionId) ?? 99) - (order.get(b.divisionId) ?? 99) || a.rank - b.rank);
}

/** How much of the season has a result in. */
export function resultProgress(season: Season): { played: number; total: number } {
  const regular = season.games.filter((g) => !PLAYOFF_TYPES.has(g.type));
  return { played: regular.filter(isPlayed).length, total: regular.length };
}

/** Builds the change record for a move, or null when nothing actually moved. */
export function describeMove(
  gameId: string, from: import('./schema.js').Placement, to: import('./schema.js').Placement,
  reason: import('./schema.js').ChangeReason, note: string, now = new Date(),
): import('./schema.js').ScheduleChange | null {
  if (from.date === to.date && from.start === to.start
    && from.rink === to.rink && from.away === to.away) return null;
  return {
    id: `chg-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    gameId, at: now.toISOString(), from, to, reason, note, announced: false,
  };
}
