import type { Season, Slot } from './schema.js';
import type { LeagueManifest } from './manifest.js';
import { GAMES_PER_SHEET, slotHolds } from './schema.js';
import { weekdayOf } from './time.js';
import { bracketTemplate, isBracketSize } from './playoffs.js';

/**
 * What the playoffs need, and which ice they could have.
 *
 * The decision of which nights to hold back belongs to the engine, because
 * answering it means running the real bracket allocator. What lives here is
 * the part that is a table rather than a search: how many games each bracket
 * needs, and which slots count as game ice the season may use at all.
 */

export interface PlayoffIceNeed {
  divisionId: string;
  divisionName: string;
  /** Bracket games needing ice. 0 when this division plays no bracket. */
  games: number;
  /** Rounds, each of which needs a night clear of the round it feeds. */
  rounds: number;
  /** Why this division needs no ice held back. Empty when it does. */
  skip: string;
}

export interface PlayoffNeeds {
  /** Bracket games to be played, across every division. */
  games: number;
  /** Nights the deepest bracket needs, which is the least any window can be. */
  rounds: number;
  byDivision: PlayoffIceNeed[];
}

/**
 * Game ice the regular season may use: the right use, inside the season, and
 * on a day the league plays.
 *
 * One implementation, read by the generator and by the reservation alike.
 * Two copies of this rule drifting apart would mean holding back a night the
 * generator was never going to use, or failing to hold back one it was.
 */
export function playableGameIce(season: Season, m: LeagueManifest): Slot[] {
  return season.slots.filter((s) => {
    if (s.use !== 'game') return false;
    if (season.blackoutDates.includes(s.date)) return false;
    const wd = weekdayOf(s.date);
    if (m.scheduling.blockedWeekdays.includes(wd)) return false;
    if (m.scheduling.onlyWeekdays.length && !m.scheduling.onlyWeekdays.includes(wd)) return false;
    if (s.date < season.startDate || s.date > season.endDate) return false;
    return true;
  });
}

/**
 * How much bracket each division is actually going to play.
 *
 * A division contributes nothing when it runs no bracket, when its qualifier
 * count is not a shape we build, or when it has fewer teams than qualifiers —
 * and each of those says so in `skip`, because "the playoffs need no ice"
 * and "the playoffs are misconfigured" look identical from the outside.
 */
export function playoffNeeds(
  season: Season, m: LeagueManifest, opts: { consolation?: boolean } = {},
): PlayoffNeeds {
  const consolation = opts.consolation ?? true;
  const byDivision: PlayoffIceNeed[] = [];

  if (m.capabilities.playoffs) {
    for (const d of season.divisions) {
      const teams = season.teams.filter((t) => t.divisionId === d.id).length;
      const base = { divisionId: d.id, divisionName: d.name, games: 0, rounds: 0 };
      if (d.playoffTeams <= 0) {
        byDivision.push({ ...base, skip: 'plays no bracket' });
      } else if (!isBracketSize(d.playoffTeams)) {
        byDivision.push({ ...base, skip: `${d.playoffTeams} qualifiers is not a bracket shape` });
      } else if (d.playoffTeams > teams) {
        byDivision.push({ ...base, skip: `${d.playoffTeams} qualifiers but ${teams} team(s)` });
      } else {
        const tpl = bracketTemplate(d.playoffTeams, consolation);
        byDivision.push({
          ...base, skip: '',
          games: tpl.length,
          rounds: new Set(tpl.map((n) => n.round)).size,
        });
      }
    }
  }

  return {
    games: byDivision.reduce((x, n) => x + n.games, 0),
    rounds: Math.max(0, ...byDivision.map((n) => n.rounds)),
    byDivision,
  };
}
