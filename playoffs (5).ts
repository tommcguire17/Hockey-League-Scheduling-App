import type { Season, Game, GameType, SeedSource } from './schema.js';
import { PLAYOFF_TYPES } from './schema.js';
import type { LeagueManifest } from './manifest.js';
import { standings, isPlayed } from './standings.js';

/**
 * What a bracket IS, separate from where its games are played.
 *
 * This file knows the shapes (who meets whom, who feeds what) and how to read
 * a result off one. Finding ice for the games is the engine's job, because
 * that is a search and this is a table.
 */

/** Bracket sizes with a sensible, conventional shape. */
export const BRACKET_SIZES = [2, 3, 4, 6, 8] as const;
export type BracketSize = (typeof BRACKET_SIZES)[number];

export function isBracketSize(n: number): n is BracketSize {
  return (BRACKET_SIZES as readonly number[]).includes(n);
}

export interface BracketNode {
  /** Stable short code, unique within a division: qf1, sf2, f, c. */
  code: string;
  type: GameType;
  /** 1 for the first round played. Later rounds have higher numbers. */
  round: number;
  home: SeedSource;
  away: SeedSource;
}

const seed = (rank: number): SeedSource => ({ kind: 'seed', rank, gameId: null });
const winner = (code: string): SeedSource => ({ kind: 'winner', rank: null, gameId: code });
const loser = (code: string): SeedSource => ({ kind: 'loser', rank: null, gameId: code });

/**
 * The bracket for a given number of qualifiers.
 *
 * Standard seeding throughout: the better seed is at home, and byes go to the
 * top seeds. Returned in dependency order, so a node never refers forward.
 *
 * 2  final only
 * 3  2v3, winner meets 1 in the final
 * 4  1v4 and 2v3, winners meet
 * 6  1 and 2 bye; 3v6 and 4v5; winners cross into the semifinals
 * 8  1v8, 4v5, 2v7, 3v6
 *
 * `gameId` on each source holds a NODE CODE here. generatePlayoffs rewrites
 * them into real game ids once the games exist.
 */
export function bracketTemplate(size: BracketSize, consolation = true): BracketNode[] {
  const n: BracketNode[] = [];
  const sf = (code: string, h: SeedSource, a: SeedSource, round: number) =>
    n.push({ code, type: 'semifinal', round, home: h, away: a });
  const qf = (code: string, h: SeedSource, a: SeedSource) =>
    n.push({ code, type: 'quarterfinal', round: 1, home: h, away: a });

  if (size === 2) {
    n.push({ code: 'f', type: 'final', round: 1, home: seed(1), away: seed(2) });
    return n;
  }
  if (size === 3) {
    sf('sf1', seed(2), seed(3), 1);
    n.push({ code: 'f', type: 'final', round: 2, home: seed(1), away: winner('sf1') });
    return n;
  }
  if (size === 4) {
    sf('sf1', seed(1), seed(4), 1);
    sf('sf2', seed(2), seed(3), 1);
  } else if (size === 6) {
    qf('qf1', seed(3), seed(6));
    qf('qf2', seed(4), seed(5));
    sf('sf1', seed(1), winner('qf2'), 2);
    sf('sf2', seed(2), winner('qf1'), 2);
  } else {
    qf('qf1', seed(1), seed(8));
    qf('qf2', seed(4), seed(5));
    qf('qf3', seed(2), seed(7));
    qf('qf4', seed(3), seed(6));
    sf('sf1', winner('qf1'), winner('qf2'), 2);
    sf('sf2', winner('qf3'), winner('qf4'), 2);
  }

  const last = size === 4 ? 2 : 3;
  n.push({ code: 'f', type: 'final', round: last, home: winner('sf1'), away: winner('sf2') });
  if (consolation) {
    n.push({ code: 'c', type: 'consolation', round: last, home: loser('sf1'), away: loser('sf2') });
  }
  return n;
}

/** How many games a bracket of this size needs. */
export function bracketGameCount(size: BracketSize, consolation = true): number {
  return bracketTemplate(size, consolation).length;
}

export const ROUND_LABELS: Record<string, string> = {
  quarterfinal: 'Quarterfinal',
  semifinal: 'Semifinal',
  final: 'Final',
  consolation: 'Third place',
};

/** What to print where a team name will eventually go. */
export function sourceLabel(src: SeedSource, codeOf?: (gameId: string) => string): string {
  if (src.kind === 'seed') return `Seed ${src.rank}`;
  const id = src.gameId ?? '';
  const code = (codeOf ? codeOf(id) : id).toUpperCase();
  return `${src.kind === 'winner' ? 'Winner' : 'Loser'} ${code}`;
}

/** The code at the end of a generated playoff game id, e.g. "po-u12-sf1" -> "SF1". */
export function codeOfGameId(gameId: string): string {
  const bit = gameId.split('-').at(-1) ?? gameId;
  return bit;
}

export const playoffGames = (season: Season): Game[] =>
  season.games.filter((g) => PLAYOFF_TYPES.has(g.type));

/** A season with every bracket game removed, freeing their ice. */
export function clearPlayoffs(season: Season, divisionId?: string): Season {
  const gone = new Set(playoffGames(season)
    .filter((g) => !divisionId || g.divisionId === divisionId).map((g) => g.id));
  if (!gone.size) return season;
  return {
    ...season,
    games: season.games.filter((g) => !gone.has(g.id)),
    changes: season.changes.filter((c) => !gone.has(c.gameId)),
  };
}

/**
 * Bracket games grouped into rounds, derived from what feeds what rather than
 * from a stored round number, so a hand-edited bracket still lays out right.
 */
export function bracketRounds(season: Season, divisionId: string): Game[][] {
  const games = playoffGames(season).filter((g) => g.divisionId === divisionId);
  const byId = new Map(games.map((g) => [g.id, g]));
  const depth = new Map<string, number>();
  const of = (g: Game, seen: Set<string>): number => {
    const hit = depth.get(g.id);
    if (hit !== undefined) return hit;
    if (seen.has(g.id)) return 1;                      // a cycle: refuse to loop
    seen.add(g.id);
    let d = 1;
    for (const src of [g.homeFrom, g.awayFrom]) {
      if (!src || src.kind === 'seed' || !src.gameId) continue;
      const feeder = byId.get(src.gameId);
      if (feeder) d = Math.max(d, of(feeder, seen) + 1);
    }
    depth.set(g.id, d);
    return d;
  };
  for (const g of games) of(g, new Set());
  const max = Math.max(0, ...depth.values());
  const out: Game[][] = Array.from({ length: max }, () => []);
  for (const g of games) out[(depth.get(g.id) ?? 1) - 1]!.push(g);
  for (const r of out) r.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export interface BracketProgress {
  /** Regular-season games in this division still without a score. */
  pendingRegular: number;
  /** Bracket games whose two teams are both known. */
  ready: number;
  /** Bracket games still waiting on a result upstream. */
  waiting: number;
  champion: string | null;
}

/**
 * Fills in every bracket team that can be known right now, and nothing else.
 *
 * Pure, idempotent, and cheap enough to run after every keystroke in the
 * scores table: seeds come from the live standings, winners from played
 * games. A game that is locked or already has a score is never touched, so a
 * hand-made matchup survives.
 *
 * Returns the SAME season object when nothing changed, which is what lets the
 * console call it on every edit without re-rendering forever.
 */
export function resolveBracket(season: Season, m: LeagueManifest): Season {
  const bracket = playoffGames(season);
  if (!bracket.length) return season;

  const table = standings(season, m);
  const seedOf = new Map<string, string>();            // "div|rank" -> teamId
  for (const r of table) seedOf.set(`${r.divisionId}|${r.rank}`, r.teamId);

  const byId = new Map(season.games.map((g) => [g.id, g]));
  const resolved = new Map<string, Game>();            // id -> game as it now stands

  /** Depth-first so a feeder is always settled before the game it feeds. */
  const settle = (g: Game, seen: Set<string>): Game => {
    const done = resolved.get(g.id);
    if (done) return done;
    if (seen.has(g.id)) return g;                      // cycle: leave it alone
    seen.add(g.id);

    const pick = (src: SeedSource | null): string | null => {
      if (!src) return null;
      if (src.kind === 'seed') return seedOf.get(`${g.divisionId}|${src.rank}`) ?? null;
      const feeder = src.gameId ? byId.get(src.gameId) : undefined;
      if (!feeder) return null;
      const f = settle(feeder, seen);
      if (!isPlayed(f) || !f.homeTeamId || !f.awayTeamId) return null;
      if (f.homeGoals === f.awayGoals) return null;    // a tie decides nothing
      const won = f.homeGoals! > f.awayGoals! ? f.homeTeamId : f.awayTeamId;
      const lost = f.homeGoals! > f.awayGoals! ? f.awayTeamId : f.homeTeamId;
      return src.kind === 'winner' ? won : lost;
    };

    let next = g;
    // A result, or a deliberate lock, outranks anything the bracket computes —
    // but only once the game has two teams. A score typed into a bracket slot
    // whose teams are still unknown must not freeze it empty for good.
    const frozen = (g.locked || isPlayed(g)) && !!g.homeTeamId && !!g.awayTeamId;
    const home = frozen ? g.homeTeamId : pick(g.homeFrom);
    const away = frozen ? g.awayTeamId : pick(g.awayFrom);
    const homeLabel = g.homeFrom ? sourceLabel(g.homeFrom, codeOfGameId) : g.homeLabel;
    const awayLabel = g.awayFrom ? sourceLabel(g.awayFrom, codeOfGameId) : g.awayLabel;
    if (home !== g.homeTeamId || away !== g.awayTeamId
      || homeLabel !== g.homeLabel || awayLabel !== g.awayLabel) {
      next = { ...g, homeTeamId: home, awayTeamId: away, homeLabel, awayLabel };
    }
    resolved.set(g.id, next);
    return next;
  };

  let changed = false;
  for (const g of bracket) {
    const next = settle(g, new Set());
    if (next !== g) changed = true;
  }
  if (!changed) return season;
  return { ...season, games: season.games.map((g) => resolved.get(g.id) ?? g) };
}

/** Where each division's bracket has got to. For the console and the checks. */
export function bracketProgress(
  season: Season, divisionId: string,
): BracketProgress {
  const inDiv = season.games.filter((g) => g.divisionId === divisionId);
  const bracket = inDiv.filter((g) => PLAYOFF_TYPES.has(g.type));
  const final = bracket.find((g) => g.type === 'final');
  let champion: string | null = null;
  if (final && isPlayed(final) && final.homeGoals !== final.awayGoals) {
    const id = final.homeGoals! > final.awayGoals! ? final.homeTeamId : final.awayTeamId;
    champion = season.teams.find((t) => t.id === id)?.name ?? id;
  }
  return {
    pendingRegular: inDiv.filter((g) => !PLAYOFF_TYPES.has(g.type) && !isPlayed(g)).length,
    ready: bracket.filter((g) => g.homeTeamId && g.awayTeamId).length,
    waiting: bracket.filter((g) => !g.homeTeamId || !g.awayTeamId).length,
    champion,
  };
}
