import type { LeagueManifest } from './manifest.js';
import type { Season } from './schema.js';
import { PLAYOFF_TYPES } from './schema.js';
import { evaluationStatus } from './evaluations.js';
import { bracketGameCount, isBracketSize } from './playoffs.js';
import { validateSeason, type ValidationResult } from './invariants.js';

/**
 * Is this season ready to send out?
 *
 * The validator answers a different question. It returns every rule that is
 * broken, which is what you want while building a schedule and exactly what
 * you do not want when deciding whether to publish one: eighty-one warnings
 * is not an answer, it is a reading exercise.
 *
 * So this is the same shape the evaluations check settled on, applied to
 * everything a division needs: a short list of conditions, each met or not,
 * each saying what is missing in words. The percentage has a denominator
 * nobody maintains — how many conditions apply — so it cannot drift, and
 * 100% means there is nothing left to do.
 */

export interface Criterion {
  id: string;
  label: string;
  met: boolean;
  /** 0 to 1, for a bar. A met criterion is always 1. */
  progress: number;
  /** What is done, or what is missing. Always a sentence fragment. */
  detail: string;
}

export interface DivisionReadiness {
  divisionId: string;
  divisionName: string;
  criteria: Criterion[];
  met: number;
  total: number;
  percent: number;
  ready: boolean;
}

export interface SeasonReadiness {
  divisions: DivisionReadiness[];
  /** Conditions that are about the season as a whole, not one division. */
  league: Criterion[];
  met: number;
  total: number;
  percent: number;
  ready: boolean;
  /** Everything still outstanding, in one list, worst first. */
  blockers: string[];
}

const pct = (met: number, total: number) =>
  (total ? Math.round((met / total) * 100) : 100);

const crit = (
  id: string, label: string, met: boolean, progress: number, detail: string,
): Criterion => ({ id, label, met, progress: met ? 1 : Math.max(0, Math.min(1, progress)), detail });

export function readiness(
  season: Season, m: LeagueManifest, result?: ValidationResult,
): SeasonReadiness {
  const v = result ?? validateSeason(season, m);
  const evals = new Map(evaluationStatus(season).map((e) => [e.divisionId, e]));
  const slotById = new Map(season.slots.map((s) => [s.id, s]));

  // Which division does an error belong to? Violations name a team, a game, a
  // practice or a division, so resolve all four back to a division and the
  // count lands where someone can act on it.
  const owner = new Map<string, string>();
  for (const d of season.divisions) owner.set(d.id, d.id);
  for (const t of season.teams) owner.set(t.id, t.divisionId);
  for (const g of season.games) owner.set(g.id, g.divisionId);
  for (const p of season.practices) owner.set(p.id, p.divisionId);
  const errorsFor = new Map<string, number>();
  let looseErrors = 0;
  for (const x of v.violations) {
    if (x.severity !== 'error') continue;
    const div = x.subject ? owner.get(x.subject) : undefined;
    if (div) errorsFor.set(div, (errorsFor.get(div) ?? 0) + 1);
    else looseErrors++;
  }

  const divisions: DivisionReadiness[] = season.divisions.map((d) => {
    const teams = season.teams.filter((t) => t.divisionId === d.id);
    const criteria: Criterion[] = [];

    // --- teams ---------------------------------------------------------------
    criteria.push(crit('teams', 'Teams', teams.length >= 2, teams.length / 2,
      teams.length >= 2 ? `${teams.length} teams`
        : teams.length ? `only ${teams.length} team — needs at least 2` : 'no teams yet'));

    // --- evaluations ---------------------------------------------------------
    const e = evals.get(d.id);
    if (e && (e.wanted > 0 || e.dates.length > 0)) {
      criteria.push(crit('evaluations', 'Evaluations', e.fulfilled,
        e.wanted ? e.booked / e.wanted : 1,
        e.fulfilled
          ? `${e.booked} session${e.booked === 1 ? '' : 's'}, plays from ${e.playsFrom}`
          : e.blockers.join('; ')));
    }

    // --- games ---------------------------------------------------------------
    const target = d.gamesPerTeam ?? m.scheduling.defaultGamesPerTeam;
    if (target > 0 && teams.length >= 2) {
      const report = v.teams.filter((t) => t.divisionId === d.id);
      const short = report.filter((t) => t.games < t.gamesTarget);
      const over = report.filter((t) => t.games > t.gamesTarget);
      const got = report.reduce((n, t) => n + t.games, 0);
      const want = teams.length * target;
      criteria.push(crit('games', 'Games', short.length === 0 && over.length === 0,
        want ? got / want : 1,
        short.length === 0 && over.length === 0
          ? `${target} each`
          : over.length
            ? `${over.length} team${over.length === 1 ? '' : 's'} over ${target}`
            : `${short.length} team${short.length === 1 ? ' is' : 's are'} short of ${target}`));
    }

    // --- practices -----------------------------------------------------------
    const pTarget = m.capabilities.practices
      ? (d.practicesPerTeam ?? m.scheduling.defaultPracticesPerTeam) : 0;
    if (pTarget > 0 && teams.length) {
      const report = v.teams.filter((t) => t.divisionId === d.id);
      const short = report.filter((t) => t.practices < t.practicesTarget);
      const got = report.reduce((n, t) => n + t.practices, 0);
      criteria.push(crit('practices', 'Practices', short.length === 0,
        got / (teams.length * pTarget),
        short.length === 0 ? `${pTarget} each`
          : `${short.length} team${short.length === 1 ? ' is' : 's are'} short of ${pTarget}`));
    }

    // --- playoffs ------------------------------------------------------------
    if (m.capabilities.playoffs && d.playoffTeams > 0) {
      const bracket = season.games.filter(
        (g) => g.divisionId === d.id && PLAYOFF_TYPES.has(g.type));
      const withIce = bracket.filter((g) => g.slotId || g.away).length;
      const needed = isBracketSize(d.playoffTeams)
        ? bracketGameCount(d.playoffTeams, bracket.some((g) => g.type === 'consolation'))
        : 0;
      criteria.push(crit('playoffs', 'Playoffs',
        needed > 0 && withIce >= needed, needed ? withIce / needed : 0,
        !bracket.length ? `top ${d.playoffTeams} qualify, no bracket built yet`
          : withIce >= needed ? `${withIce} games on the ice`
            : `${needed - withIce} of ${needed} bracket games have no ice`));
    }

    // --- nothing broken ------------------------------------------------------
    const errs = errorsFor.get(d.id) ?? 0;
    criteria.push(crit('clean', 'Checks', errs === 0, errs ? 0 : 1,
      errs ? `${errs} error${errs === 1 ? '' : 's'} to clear` : 'no errors'));

    const met = criteria.filter((c) => c.met).length;
    return {
      divisionId: d.id,
      divisionName: d.name,
      criteria,
      met,
      total: criteria.length,
      percent: pct(met, criteria.length),
      ready: met === criteria.length,
    };
  });

  // --- the season as a whole -------------------------------------------------
  const league: Criterion[] = [];
  league.push(crit('ice', 'Ice booked', season.slots.length > 0,
    season.slots.length ? 1 : 0,
    season.slots.length ? `${season.slots.length} slots` : 'no ice imported yet'));

  const unplaced = season.games.filter((g) => !g.slotId && !g.away).length;
  league.push(crit('placed', 'Every game has ice', unplaced === 0,
    season.games.length ? 1 - unplaced / season.games.length : 1,
    unplaced ? `${unplaced} game${unplaced === 1 ? '' : 's'} with nowhere to play`
      : `${season.games.length} games placed`));

  const orphanEvals = season.slots.filter(
    (s) => s.use === 'evaluation' && !s.ownerDivisionId).length;
  if (orphanEvals) {
    league.push(crit('evalOwners', 'Evaluation ice assigned', false, 0,
      `${orphanEvals} evaluation slot${orphanEvals === 1 ? '' : 's'} with no division`));
  }

  league.push(crit('errors', 'Nothing broken', v.errorCount === 0, v.errorCount ? 0 : 1,
    v.errorCount ? `${v.errorCount} error${v.errorCount === 1 ? '' : 's'} across the season`
      : `clean, ${v.warningCount} warning${v.warningCount === 1 ? '' : 's'}`));

  void slotById;
  void looseErrors;

  const all = [...league, ...divisions.flatMap((d) => d.criteria)];
  const met = all.filter((c) => c.met).length;
  const blockers = [
    ...league.filter((c) => !c.met).map((c) => `${c.label}: ${c.detail}`),
    ...divisions.flatMap((d) => d.criteria.filter((c) => !c.met)
      .map((c) => `${d.divisionName} — ${c.label}: ${c.detail}`)),
  ];

  return {
    divisions,
    league,
    met,
    total: all.length,
    percent: pct(met, all.length),
    ready: met === all.length,
    blockers,
  };
}
