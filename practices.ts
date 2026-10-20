import type {
  Season, Slot, Practice, Team, LeagueManifest, RepurposeSuggestion,
} from '@league/core';
import {
  gameWhen, playFloors, playableOn, suggestRepurpose, weekKey, weekdayOf,
} from '@league/core';

/**
 * Practices and evaluations.
 *
 * The generator used to produce games and nothing else, so a season built
 * from a CSV came back with an empty practice list and a House League that
 * owes every team thirteen practices had none.
 *
 * The shape of practice ice is not the shape of game ice. Games compete for
 * single slots; practices are standing weekly bookings owned by an age group,
 * and a team keeps the same night all season because that is what families
 * plan around. So this does not search: it hands each team a home night and
 * keeps it there, moving a team only when its own night is unusable.
 */

export interface PracticeOptions {
  /** Overwrite practices already in the season. Default true. */
  replace?: boolean;
}

export interface PracticeDivisionReport {
  divisionId: string;
  divisionName: string;
  teams: number;
  target: number;
  /** Fewest and most practices any one team got. Equal is the goal. */
  min: number;
  max: number;
  slotsUsed: number;
  /** Weekly patterns the division practises on, in words. */
  patterns: string[];
  note: string;
}

export interface PracticeReport {
  byDivision: PracticeDivisionReport[];
  practices: number;
  evaluations: number;
  /** Practice ice nobody could use, and why. */
  unusedPracticeSlots: number;
  issues: string[];
  /**
   * Ice that could be turned into what is missing. Proposals only: nothing
   * here has been applied, and nothing will be until somebody says so.
   */
  suggestions: RepurposeSuggestion[];
}

export interface PracticeResult { practices: Practice[]; report: PracticeReport }

const DAY_NAME: Record<string, string> = {
  sunday: 'Sun', monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed',
  thursday: 'Thu', friday: 'Fri', saturday: 'Sat',
};
const patternOf = (s: Slot) => `${DAY_NAME[weekdayOf(s.date)]} ${s.start}`;

/**
 * Assigns teams to practice ice, then books the evaluation sheets.
 *
 * Pure. Reads the games already in the season so a team is not asked to
 * practise on a day it plays, where the league forbids that.
 */
export function assignPractices(
  season: Season, m: LeagueManifest, opts: PracticeOptions = {},
): PracticeResult {
  const issues: string[] = [];
  const byDivision: PracticeDivisionReport[] = [];
  const out: Practice[] = [];

  if (!m.capabilities.practices) {
    return {
      practices: opts.replace === false ? season.practices : [],
      report: {
        byDivision: [], practices: 0, evaluations: 0, unusedPracticeSlots: 0,
        issues: [`${m.name} has no practices.`], suggestions: [],
      },
    };
  }

  const slotById = new Map(season.slots.map((s) => [s.id, s]));
  // A division does not practise before it has been evaluated either.
  const floors = playFloors(season);

  // Dates each team already plays on, so a practice is not stacked on a game.
  const gameDates = new Map<string, Set<string>>();
  for (const g of season.games) {
    const w = gameWhen(g, slotById);
    if (!w) continue;
    for (const t of [g.homeTeamId, g.awayTeamId]) {
      if (!t) continue;
      (gameDates.get(t) ?? gameDates.set(t, new Set()).get(t)!).add(w.date);
    }
  }

  const usable = (s: Slot): boolean => {
    if (season.blackoutDates.includes(s.date)) return false;
    if (s.date < season.startDate || s.date > season.endDate) return false;
    const wd = weekdayOf(s.date);
    if (m.scheduling.blockedWeekdays.includes(wd)) return false;
    return true;
  };
  const canPractise = (t: Team, s: Slot): boolean => {
    if (t.blackoutDates.includes(s.date)) return false;
    if (t.allowedWeekdays.length && !t.allowedWeekdays.includes(weekdayOf(s.date))) return false;
    if (!m.scheduling.allowGameAndPracticeSameDay && gameDates.get(t.id)?.has(s.date)) return false;
    return true;
  };

  const practiceSlots = season.slots.filter((s) => s.use === 'practice' && usable(s));
  const claimed = new Set<string>();
  const suggestions: RepurposeSuggestion[] = [];
  let n = 0;

  for (const d of season.divisions) {
    const teams = season.teams.filter((t) => t.divisionId === d.id);
    const target = d.practicesPerTeam ?? m.scheduling.defaultPracticesPerTeam;
    const mine = practiceSlots.filter(
      (s) => s.ownerDivisionId === d.id && playableOn(floors, d.id, s.date));
    const report: PracticeDivisionReport = {
      divisionId: d.id, divisionName: d.name, teams: teams.length, target,
      min: 0, max: 0, slotsUsed: 0, patterns: [], note: '',
    };
    byDivision.push(report);
    if (!teams.length || target <= 0) continue;

    // Ice nobody has claimed is fair game, but only after owned ice.
    const open = practiceSlots.filter((s) => !s.ownerDivisionId && !claimed.has(s.id)
      && playableOn(floors, d.id, s.date));
    const pool = [...mine, ...open]
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    if (!pool.length) {
      const floor = floors.get(d.id);
      report.note = 'No practice ice is assigned to this division'
        + (floor ? ` after its evaluations on ${floor}` : '')
        + '. Set the owner on Ice, or add a rule for its practice night.';
      issues.push(`${d.name}: ${report.note}`);
      suggestions.push(...suggestRepurpose(season, m, {
        use: 'practice', count: target, divisionId: d.id,
        reason: `${d.name} has no practice ice at all`,
      }));
      continue;
    }

    // Each team gets a home night and keeps it, which is what families plan
    // around. Patterns are ordered by how much ice they carry so the biggest
    // standing booking is handed out first.
    const patterns = [...new Set(pool.map(patternOf))]
      .sort((a, b) => pool.filter((s) => patternOf(s) === b).length
        - pool.filter((s) => patternOf(s) === a).length || a.localeCompare(b));
    report.patterns = patterns;
    const home = new Map<string, string>();
    teams.forEach((t, i) => home.set(t.id, patterns[i % patterns.length]!));

    const done = new Map(teams.map((t) => [t.id, 0]));
    const perWeek = new Map<string, Set<string>>();      // week -> teams already on
    const booked = new Map<string, string[]>();          // slotId -> teamIds

    const cap = (s: Slot) => (s.practiceTeams > 0 ? s.practiceTeams
      : Math.ceil(teams.length / Math.max(1, pool.filter(
        (x) => weekKey(x.date, m.week.startsOn) === weekKey(s.date, m.week.startsOn)).length)));

    const take = (s: Slot, t: Team): boolean => {
      const list = booked.get(s.id) ?? [];
      if (list.length >= cap(s)) return false;
      if ((done.get(t.id) ?? 0) >= target) return false;
      if (!canPractise(t, s)) return false;
      const wk = weekKey(s.date, m.week.startsOn);
      const on = perWeek.get(wk) ?? perWeek.set(wk, new Set()).get(wk)!;
      if (on.has(t.id) && m.scheduling.maxPracticesPerWeek <= 1) return false;
      list.push(t.id);
      booked.set(s.id, list);
      on.add(t.id);
      done.set(t.id, (done.get(t.id) ?? 0) + 1);
      return true;
    };

    // Pass one: everybody on their home night.
    for (const s of pool) {
      for (const t of teams) if (home.get(t.id) === patternOf(s)) take(s, t);
    }
    // Pass two: a team that lost its night to a blackout takes another the
    // same week rather than simply going short.
    for (const s of pool) {
      for (const t of teams) if (home.get(t.id) !== patternOf(s)) take(s, t);
    }

    const counts = teams.map((t) => done.get(t.id) ?? 0);
    report.min = Math.min(...counts);
    report.max = Math.max(...counts);
    report.slotsUsed = [...booked.values()].filter((v) => v.length).length;

    for (const [slotId, teamIds] of booked) {
      if (!teamIds.length) continue;
      claimed.add(slotId);
      out.push({
        id: `pr-${d.id}-${String(++n).padStart(3, '0')}`,
        divisionId: d.id, slotId, teamIds, kind: 'practice',
      });
    }

    if (report.min < target) {
      const short = teams.length * target - counts.reduce((a, b) => a + b, 0);
      report.note = `${short} team-practices short of ${target} each. `
        + `${pool.length} slots on ${patterns.join(', ')} for ${teams.length} teams.`;
      issues.push(`${d.name}: ${report.note}`);
      suggestions.push(...suggestRepurpose(season, m, {
        use: 'practice', count: target - report.min, divisionId: d.id,
        reason: `${d.name} is ${short} team-practices short`,
      }));
    } else {
      report.note = `${target} each on ${patterns.join(' and ')}.`;
    }
  }

  // ---- evaluations ----------------------------------------------------------
  const evalSlots = season.slots.filter((s) => s.use === 'evaluation');
  let evals = 0;
  for (const s of evalSlots.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))) {
    const div = s.ownerDivisionId;
    if (!div) {
      issues.push(`Evaluation ice on ${s.date} ${s.start} names no division, so nobody is on it. `
        + 'Set the division on Ice.');
      continue;
    }
    const teams = season.teams.filter((t) => t.divisionId === div);
    out.push({
      id: `ev-${div}-${String(++evals).padStart(2, '0')}`,
      divisionId: div, slotId: s.id,
      // Evaluations are the whole age group on the ice at once. Before teams
      // exist the session is still real ice with a date, so it is kept with
      // an empty roster rather than dropped.
      teamIds: teams.map((t) => t.id),
      kind: 'evaluation',
    });
  }
  for (const d of season.divisions) {
    // Zero is the default: a division only asks for evaluation ice by
    // ticking the number up, so nothing nags a league that never runs them.
    const want = d.evaluationSessions;
    if (want <= 0) continue;
    const booked = evalSlots.filter((s) => s.ownerDivisionId === d.id).length;
    if (booked >= want) continue;
    const short = want - booked;
    issues.push(booked === 0
      ? `${d.name} needs ${want} evaluation session${want === 1 ? '' : 's'} and has none. `
        + 'Repurpose a slot to Evaluation, or mark one on Ice.'
      : `${d.name} needs ${want} evaluation sessions but only `
        + `${booked} sheet${booked === 1 ? ' is' : 's are'} marked for it.`);
    // Evaluations come BEFORE the season, in the hour families already look
    // for, which at this rink is usually a sheet booked as a game. So the
    // window ends at the division's first game and occupied game ice is fair
    // game, as long as that game has somewhere else to go.
    // Evaluations are the FIRST thing a division does, so the window ends at
    // whatever it does first — a game or a practice, whichever comes sooner.
    const firstPlay = [
      ...season.games.filter((g) => g.divisionId === d.id)
        .map((g) => (g.slotId ? slotById.get(g.slotId)?.date : g.away?.date)),
      ...out.filter((x) => x.divisionId === d.id && x.kind === 'practice')
        .map((x) => slotById.get(x.slotId)?.date),
    ].filter((x): x is string => !!x).sort()[0];
    // Offer a few, not one: which hour the skate sits in is a judgement about
    // what families expect, and that is not the app's call to make.
    // Enough options to choose from, since which hour the skate sits in is a
    // judgement about what families expect and not the app's call. A division
    // running two sessions needs two, so offer a couple more than that.
    suggestions.push(...suggestRepurpose(season, m, {
      use: 'evaluation', count: short + 2, divisionId: d.id,
      until: firstPlay ?? addDays(season.startDate, 45),
      allowOccupied: true,
      reason: `${d.name} needs ${short} more evaluation sheet${short === 1 ? '' : 's'}`,
    }));
  }

  const kept = opts.replace === false ? season.practices : [];
  const practices = [...kept, ...out];
  return {
    practices,
    report: {
      byDivision,
      practices: out.filter((p) => p.kind === 'practice').length,
      evaluations: evals,
      unusedPracticeSlots: practiceSlots.filter((s) => !claimed.has(s.id)).length,
      issues,
      suggestions: dedupe(suggestions),
    },
  };
}

/** One slot can only be repurposed once, however many shortfalls it answers. */
function dedupe(list: RepurposeSuggestion[]): RepurposeSuggestion[] {
  const seen = new Set<string>();
  return list.filter((s) => (seen.has(s.slotId) ? false : (seen.add(s.slotId), true)));
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
