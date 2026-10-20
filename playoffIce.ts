import type { LeagueManifest, PlayoffIceNeed, Season } from '@league/core';
import { PLAYOFF_TYPES, playableGameIce, playoffNeeds } from '@league/core';
import { generatePlayoffs } from './playoffs.js';

/**
 * Holding ice back for the playoffs.
 *
 * A regular season generated without this spreads itself across every night
 * of booked ice, because spreading out is what makes a schedule pleasant:
 * one game a week, no crowding. It is also what leaves the brackets with
 * nowhere to play, since a bracket game may only go on ice AFTER its
 * division's last regular game. The generator would finish on the final
 * night of the season and then report that the playoffs have no ice — both
 * halves working exactly as written, and the season unusable. That is the
 * bug this file exists to prevent.
 *
 * So the last few nights of game ice are reserved before the regular season
 * is placed, and the regular season is fitted into what is left. That is what
 * produces the second game in a week the rink was always going to need: the
 * same games into fewer nights. The soft weekly rule already prices a double
 * cheapest late in the season, so the doubles land in February and March
 * rather than November, which is where a rink would put them anyway.
 *
 * ---
 *
 * How big the window has to be is not arithmetic. Sixteen bracket games do
 * not need sixteen openings on any sixteen nights: a semifinal cannot share a
 * night with the final it feeds, a sheet reserved for 10U is no use to 12U,
 * and a cross-ice sheet holds two games for one division and one for another.
 * Every attempt to approximate those rules here would be a second, worse copy
 * of the allocator that really places the brackets — and a copy that reads
 * "16 games, 16 openings, fine" hands back a schedule whose playoffs then do
 * not fit, which is the original bug wearing a different hat.
 *
 * So the allocator itself is the oracle. For a candidate window, ask it to
 * place every bracket as though the regular season had ended the night
 * before, and believe the answer. The walk starts at the last night and takes
 * one more night at a time, stopping at the FEWEST that work, because every
 * night held back is a night the regular season must squeeze into.
 */

export interface PlayoffIcePlan {
  /** Game-ice nights held back from the regular season, earliest first. */
  dates: string[];
  /** Bracket games to be played, across every division. */
  games: number;
  /** Nights the deepest bracket needs. No window can usefully be smaller. */
  rounds: number;
  /** Bracket games the allocator could place in the window. */
  placeable: number;
  byDivision: PlayoffIceNeed[];
  /** True when the window holds every bracket game. */
  sufficient: boolean;
  /** What is short, in words. Empty when sufficient. */
  issues: string[];
}

/**
 * Never hand back a window wider than this share of the season's game nights.
 * A bracket needing more is not a reservation problem but a booking one, and
 * saying so beats answering a stranded final with a December full of doubles.
 */
const MAX_SHARE = 0.5;

/**
 * Does this league play a third-place game?
 *
 * An explicit ask wins, then the bracket already on the ice — a season with
 * semifinals and no third-place game has answered the question whatever any
 * setting says — and otherwise the season's own setting. The generator runs
 * long before anyone opens the Playoffs tab, and when it had to guess it
 * guessed yes and held back a whole extra night of ice for a game the league
 * does not play.
 */
function playsConsolation(season: Season, asked?: boolean): boolean {
  if (asked !== undefined) return asked;
  const bracket = season.games.filter((g) => PLAYOFF_TYPES.has(g.type));
  if (bracket.some((g) => g.type === 'consolation')) return true;
  if (bracket.some((g) => g.type === 'semifinal')) return false;
  return season.playoffConsolation;
}

/**
 * Ask the allocator what it could do with a window opening on `from`.
 *
 * The probe season keeps the slots, the practices and any bracket already
 * built — practices are ice genuinely in use, and a kept bracket is a
 * decision already made — but drops the regular season, which has not been
 * placed yet and whose whole position is what this is deciding. `from`
 * stands in for "every division finished the night before".
 */
function probeFrom(
  season: Season, m: LeagueManifest, from: string, opts: { consolation?: boolean },
): number {
  const r = generatePlayoffs(
    { ...season, games: season.games.filter((g) => PLAYOFF_TYPES.has(g.type)) },
    m, { consolation: playsConsolation(season, opts.consolation), from },
  );
  return r.report.placed;
}

export function planPlayoffIce(
  season: Season, m: LeagueManifest, opts: { consolation?: boolean } = {},
): PlayoffIcePlan {
  const needs = playoffNeeds(season, m,
    { consolation: playsConsolation(season, opts.consolation) });
  const empty: PlayoffIcePlan = {
    dates: [], games: needs.games, rounds: needs.rounds, placeable: 0,
    byDivision: needs.byDivision, sufficient: true, issues: [],
  };
  if (!needs.games) return empty;

  /**
   * Ice the rink has already marked as the playoffs' own.
   *
   * This is the stronger statement and it wins outright. Working out a
   * window from the shape of the bracket is a fallback for a season nobody
   * has made that decision about; once somebody has gone to the Booked Ice
   * tab and said "these weekends are the playoffs", there is nothing left to
   * infer. The regular season cannot reach that ice at all — `playableGameIce`
   * does not return it — so the squeeze, and the doubling up that comes with
   * it, follow from the marking rather than from a guess.
   */
  const marked = [...new Set(season.slots
    .filter((s) => s.use === 'playoff')
    .map((s) => s.date))].sort();
  if (marked.length) {
    const placed = probeFrom(season, m, marked[0]!, opts);
    const short = Math.max(0, needs.games - placed);
    return {
      dates: marked,
      games: needs.games,
      rounds: needs.rounds,
      placeable: placed,
      byDivision: needs.byDivision,
      sufficient: short === 0,
      issues: short
        ? [`${short} of ${needs.games} playoff game(s) do not fit the `
          + `${marked.length} night(s) marked as playoff ice `
          + `(${marked[0]} to ${marked.at(-1)}). Mark another night on Booked Ice, `
          + 'or run smaller brackets.']
        : [],
    };
  }

  const nights = [...new Set(playableGameIce(season, m).map((s) => s.date))].sort();
  if (!nights.length) {
    return { ...empty, sufficient: false,
      issues: ['No game ice in the season at all, so there is none to hold back.'] };
  }

  const probe = (from: string): number => probeFrom(season, m, from, opts);

  const sufficientOnly = (p: number) => p >= needs.games;
  const cap = Math.max(needs.rounds, Math.floor(nights.length * MAX_SHARE));
  let best = { from: nights[nights.length - 1]!, placed: 0, taken: 1 };
  for (let taken = 1; taken <= Math.min(cap, nights.length); taken++) {
    const from = nights[nights.length - taken]!;
    const placed = probe(from);
    if (placed > best.placed) best = { from, placed, taken };
    if (placed >= needs.games) break;
  }

  /**
   * One night of slack, where the season can spare it.
   *
   * The fewest nights that fit the brackets is, by construction, a window
   * with nothing to give: on Tom's season four nights hold exactly twelve
   * bracket games in twelve openings. One regular-season game spilling in —
   * and the fallback passes will spill rather than drop a fixture — then
   * costs a semifinal its ice. A night of margin absorbs that, and costs
   * nothing when it is not needed, because the regular season hands the
   * earliest reserved nights back the moment it cannot fit without them.
   */
  const sufficient = sufficientOnly(best.placed);
  const padded = Math.min(cap, nights.length, best.taken + (sufficient ? 1 : 0));
  const dates = nights.slice(nights.length - padded);
  const issues: string[] = [];
  if (!sufficient) {
    const short = needs.games - best.placed;
    issues.push(`${short} of ${needs.games} playoff game(s) have no ice even with the `
      + `last ${dates.length} night(s) of game ice held back for them. `
      + `The rink has ${nights.length} game night(s) in the season; the brackets cannot `
      + `have more than ${cap} of them without taking over the regular season.`);
  }

  return {
    dates, games: needs.games, rounds: needs.rounds, placeable: best.placed,
    byDivision: needs.byDivision, sufficient, issues,
  };
}

/**
 * Did the brackets actually survive the regular season?
 *
 * The reservation is a forecast made before a single game is placed, so it
 * cannot be the thing that reports the outcome — and estimating the outcome
 * from "openings held back minus openings taken" gets it wrong in both
 * directions, because which opening was taken matters as much as how many.
 * A night the brackets never wanted costs nothing; the one night a division
 * could have played its semifinal costs everything.
 *
 * So ask the allocator about the finished schedule and report what it says.
 */
export function playoffsFit(
  season: Season, m: LeagueManifest, opts: { consolation?: boolean } = {},
): { placed: number; needed: number; fits: boolean } {
  const needs = playoffNeeds(season, m,
    { consolation: playsConsolation(season, opts.consolation) });
  if (!needs.games) return { placed: 0, needed: 0, fits: true };
  const r = generatePlayoffs(season, m,
    { consolation: playsConsolation(season, opts.consolation) });
  return {
    placed: r.report.placed,
    needed: r.report.needed,
    fits: r.report.placed >= r.report.needed,
  };
}
