import type {
  Season, Slot, Game, SeedSource, LeagueManifest, RepurposeSuggestion,
} from '@league/core';
import {
  BRACKET_SIZES, GAME_USES, bracketTemplate, clearPlayoffs, codeOfGameId, isBracketSize,
  PLAYOFF_TYPES, resolveBracket, ROUND_LABELS, slotHolds, sourceLabel,
  suggestRepurpose, weekdayOf, type BracketNode, type BracketSize,
} from '@league/core';

/**
 * Putting a bracket on ice.
 *
 * The shape of the bracket is core's business. This file answers the only
 * question left: which booked slot does each game go in, given that a round
 * cannot start until the round feeding it has finished.
 */

export interface PlayoffOptions {
  /** Play a third-place game between the beaten semifinalists. Default true. */
  consolation?: boolean;
  /** Earliest date a bracket game may be played. Default: after the regular season. */
  from?: string;
  /** Clear days between rounds. 0 lets a round follow on the next day. */
  restDays?: number;
  /** Build only these divisions. Default: every division that qualifies anyone. */
  divisionIds?: string[];
}

export interface PlayoffDivisionReport {
  divisionId: string;
  divisionName: string;
  size: number;
  rounds: number;
  needed: number;
  placed: number;
  firstDate: string | null;
  lastDate: string | null;
  /** What happened, or what is missing, in plain words. */
  note: string;
}

export interface PlayoffReport {
  byDivision: PlayoffDivisionReport[];
  placed: number;
  needed: number;
  /** Game slots still free after the brackets are in. */
  spareSlots: number;
  /** The night the last final is played, across every division. */
  finalsOn: string | null;
  issues: string[];
  /** Ice that could become the missing games. Proposals only. */
  suggestions: RepurposeSuggestion[];
}

export interface PlayoffResult { games: Game[]; report: PlayoffReport; }

/**
 * One game's worth of ice. A cross-ice slot holds two games at once, so a slot
 * with capacity 2 yields two openings on the same sheet at the same time.
 */
interface Free { slot: Slot; key: string; id: string }

/** One round of one division's bracket, and how far it is from the final. */
interface Need {
  divisionId: string;
  roundIdx: number;
  /** Rounds that must follow this one. 0 is the final. */
  depth: number;
  size: number;
  nodes: BracketNode[];
}

const keyOf = (n: { divisionId: string; roundIdx: number }) => `${n.divisionId}|${n.roundIdx}`;

const countPlaced = (plan: Map<string, Free[]>): number =>
  [...plan.values()].reduce((n, v) => n + v.length, 0);

/**
 * Builds a bracket per division and finds ice for it.
 *
 * Replaces any bracket already there, leaves the regular season untouched, and
 * never takes a slot a regular game or a practice is using.
 */
export function generatePlayoffs(
  season: Season, m: LeagueManifest, opts: PlayoffOptions = {},
): PlayoffResult {
  // The season carries the answer, so the Schedule tab and the Playoffs tab
  // cannot disagree about how much ice the brackets need.
  const consolation = opts.consolation ?? season.playoffConsolation;
  const restDays = Math.max(0, Math.floor(opts.restDays ?? 0));
  const issues: string[] = [];

  if (!m.capabilities.playoffs) {
    return {
      games: season.games,
      report: {
        byDivision: [], placed: 0, needed: 0, spareSlots: 0, finalsOn: null,
        issues: [`${m.name} does not run playoffs. Nothing to build.`], suggestions: [],
      },
    };
  }

  // Start from a season with no bracket, so the ice the old one held is free
  // again and a rebuild is never a second bracket on top of the first.
  const base = clearPlayoffs(season);

  const taken = new Set<string>();
  for (const g of base.games) if (g.slotId) taken.add(g.slotId);
  for (const p of base.practices) if (p.teamIds.length) taken.add(p.slotId);

  /**
   * Has the rink said where the playoffs go?
   *
   * Marking ice as playoff on the Booked Ice tab is a decision, not a hint.
   * Without it the allocator takes the earliest ice that fits after the
   * regular season, which keeps a bracket compact and is right when nobody
   * has said otherwise — but it would also drop a semifinal onto a spare
   * sheet in February while the weekend somebody set aside for it sat empty.
   * So when marked ice exists the brackets go there, and ordinary game ice
   * comes back into play only if the marked nights cannot hold them.
   */
  const marked = base.slots.some((s) => s.use === 'playoff');

  const usable = (s: Slot, markedOnly: boolean): boolean => {
    // Ice marked playoff is exactly this: a game sheet the regular season was
    // not allowed to touch, kept for the brackets.
    if (markedOnly ? s.use !== 'playoff' : !GAME_USES.has(s.use)) return false;
    if (taken.has(s.id)) return false;
    if (base.blackoutDates.includes(s.date)) return false;
    const wd = weekdayOf(s.date);
    if (m.scheduling.blockedWeekdays.includes(wd)) return false;
    if (m.scheduling.onlyWeekdays.length && !m.scheduling.onlyWeekdays.includes(wd)) return false;
    return true;
  };

  // How many bracket games fit on a sheet: the division's format, unless the
  // booking overrides it. Reading slot.capacity raw used to mean zero
  // openings once capacity defaulted to "work it out".
  const divById = new Map(season.divisions.map((d) => [d.id, d]));
  const openings = (s: Slot) => {
    if (!m.capabilities.crossIce) return 1;
    return Math.max(1, slotHolds(s, divById.get(s.ownerDivisionId ?? '')));
  };
  const poolOf = (markedOnly: boolean): Free[] => base.slots
    .filter((s) => usable(s, markedOnly))
    .flatMap((s) => Array.from({ length: openings(s) }, (_, i) => ({
      slot: s, key: `${s.date}${s.start}${i}`, id: `${s.id}#${i}`,
    })))
    .sort((a, b) => a.key.localeCompare(b.key));
  let free: Free[] = poolOf(marked);

  const lastRegular = lastRegularDates(base);
  const earliestFor = (divisionId: string) =>
    opts.from ?? addDays(lastRegular.get(divisionId) ?? base.startDate, 1);

  // ---- what has to be placed ------------------------------------------------
  const byDivision: PlayoffDivisionReport[] = [];
  const suggestions: RepurposeSuggestion[] = [];
  const needs: Need[] = [];
  const templates = new Map<string, BracketNode[][]>();

  for (const d of season.divisions) {
    if (opts.divisionIds && !opts.divisionIds.includes(d.id)) continue;
    if (d.playoffTeams <= 0) continue;
    const teams = season.teams.filter((t) => t.divisionId === d.id).length;
    const report: PlayoffDivisionReport = {
      divisionId: d.id, divisionName: d.name, size: d.playoffTeams,
      rounds: 0, needed: 0, placed: 0, firstDate: null, lastDate: null, note: '',
    };
    byDivision.push(report);

    if (!isBracketSize(d.playoffTeams)) {
      report.note = `${d.playoffTeams} qualifiers is not a bracket shape I build. `
        + `Use one of ${BRACKET_SIZES.join(', ')}.`;
      issues.push(`${d.name}: ${report.note}`);
      continue;
    }
    if (d.playoffTeams > teams) {
      report.note = `${d.playoffTeams} qualifiers but only ${teams} teams in the division.`;
      issues.push(`${d.name}: ${report.note}`);
      continue;
    }

    const rounds = groupByRound(bracketTemplate(d.playoffTeams, consolation));
    templates.set(d.id, rounds);
    report.rounds = rounds.length;
    report.needed = rounds.reduce((n, r) => n + r.length, 0);
    rounds.forEach((nodes, roundIdx) => needs.push({
      divisionId: d.id, roundIdx, depth: rounds.length - 1 - roundIdx,
      size: nodes.length, nodes,
    }));
  }

  // ---- find ice for all of it, as compactly as it will fit -----------------
  const fitAll = (p: Map<string, Free[]>) =>
    needs.every((n) => (p.get(keyOf(n))?.length ?? 0) === n.size);

  /**
   * Walk a cutoff forward from the first available night and stop at the
   * first value that fits everything, so the playoffs stay compact instead
   * of sprawling to the end of the booked ice.
   */
  const bestPlan = (pool: Free[]): Map<string, Free[]> => {
    const nights = [...new Set(pool.map((f) => f.slot.date))].sort();
    let out = new Map<string, Free[]>();
    for (const cutoff of nights) {
      out = allocate(needs, pool, earliestFor, restDays, cutoff);
      if (fitAll(out)) break;
    }
    return out;
  };

  let plan = bestPlan(free);
  // Marked ice is the first answer, not the only one: a bracket that will not
  // fit the nights set aside for it still needs somewhere to play, and the
  // report says the marked ice came up short.
  if (marked && !fitAll(plan)) {
    const wider = poolOf(false);
    const widerPlan = bestPlan(wider);
    if (!fitAll(plan) && countPlaced(widerPlan) > countPlaced(plan)) {
      free = wider;
      plan = widerPlan;
      issues.push('The nights marked as playoff ice do not hold every bracket game, '
        + 'so the rest went on ordinary game ice. Mark another night on Booked Ice '
        + 'to keep the brackets together.');
    }
  }

  // ---- emit -----------------------------------------------------------------
  const games: Game[] = base.games.map((g) => ({ ...g }));
  const used = new Set<string>();

  for (const report of byDivision) {
    const rounds = templates.get(report.divisionId);
    if (!rounds) continue;
    const idOf = (code: string) => `po-${report.divisionId}-${code}`;
    let shortfall = 0;

    rounds.forEach((nodes, roundIdx) => {
      const picked = plan.get(`${report.divisionId}|${roundIdx}`) ?? [];
      if (picked.length < nodes.length) shortfall += nodes.length - picked.length;
      picked.forEach((f) => used.add(f.id));

      nodes.forEach((node, i) => {
        const f = picked[i];
        const rewrite = (src: SeedSource): SeedSource =>
          (src.kind === 'seed' ? src : { ...src, gameId: idOf(src.gameId ?? '') });
        const home = rewrite(node.home), away = rewrite(node.away);
        games.push({
          id: idOf(node.code), divisionId: report.divisionId, slotId: f ? f.slot.id : null,
          homeTeamId: null, awayTeamId: null,
          homeLabel: sourceLabel(home, codeOfGameId),
          awayLabel: sourceLabel(away, codeOfGameId),
          homeFrom: home, awayFrom: away,
          type: node.type, homeGoals: null, awayGoals: null, away: null, locked: false,
        });
        if (!f) return;
        report.placed++;
        if (!report.firstDate || f.slot.date < report.firstDate) report.firstDate = f.slot.date;
        if (!report.lastDate || f.slot.date > report.lastDate) report.lastDate = f.slot.date;
      });
    });

    const after = earliestFor(report.divisionId);
    if (shortfall) {
      // Say what is in the way, not just that something is. Ice reserved for
      // another division is the usual culprit and the easiest thing to undo.
      const reserved = free.filter((f) => !used.has(f.id) && f.slot.date >= after
        && f.slot.ownerDivisionId && f.slot.ownerDivisionId !== report.divisionId);
      const nights = [...new Set(reserved.map((f) => `${f.slot.date} ${f.slot.start} ${f.slot.rink}`))];
      report.note = `${shortfall} of ${report.needed} games have no ice. `
        + (nights.length
          ? `${nights.length} free slot(s) after ${after} are reserved for another division `
            + `(${nights.slice(0, 3).join('; ')}${nights.length > 3 ? '; …' : ''}). `
            + 'Release one on Ice, or add a slot.'
          : `Add game slots after ${after}`
            + `${restDays ? `, allowing ${restDays} rest day(s) between rounds` : ''}.`);
      issues.push(`${report.divisionName}: ${report.note}`);
      // Practice ice after the regular season is the obvious thing to flip:
      // the season is over, so nobody is practising on it.
      suggestions.push(...suggestRepurpose(season, m, {
        use: 'game', count: shortfall, divisionId: report.divisionId, from: after,
        reason: `${report.divisionName} is ${shortfall} playoff game(s) short of ice`,
      }));
    } else {
      const first = ROUND_LABELS[rounds[0]![0]!.type] ?? 'Round 1';
      report.note = rounds.length === 1
        ? `Final ${report.lastDate}.`
        : `${first} ${report.firstDate} through the final ${report.lastDate}.`;
    }
  }

  const needed = byDivision.reduce((n, r) => n + r.needed, 0);
  const placed = byDivision.reduce((n, r) => n + r.placed, 0);
  const next = resolveBracket({ ...base, games }, m);

  return {
    games: next.games,
    report: {
      byDivision, placed, needed,
      // A slot is spare only when nothing at all is on it: half a cross-ice
      // slot is not ice you can release.
      spareSlots: [...new Set(free.map((f) => f.slot.id))]
        .filter((id) => free.filter((f) => f.slot.id === id).every((f) => !used.has(f.id))).length,
      suggestions: suggestions.filter(
        (s2, i, all) => all.findIndex((x) => x.slotId === s2.slotId) === i),
      finalsOn: byDivision.map((r) => r.lastDate).filter(Boolean).sort().at(-1) ?? null,
      issues,
    },
  };
}

/**
 * Ice for every bracket at once, planned backwards from the finals.
 *
 * Working forwards is what strands a final. Every division wants the earliest
 * ice it can have for round one, and by the time the last division asks for a
 * final night there is nothing left after its semifinals. So the finals are
 * placed FIRST, on the latest ice available, and each earlier round is then
 * fitted in behind the round it feeds. Within a round the tightest division
 * goes first, because it has the fewest nights that work.
 *
 * `cutoff` caps how late the bracket may run. The caller walks it forward
 * from the first available night and stops at the first value that fits
 * everything, which is what keeps the playoffs compact instead of sprawling
 * to the end of the booked ice.
 */
function allocate(
  needs: Need[], free: Free[], earliestFor: (divisionId: string) => string,
  restDays: number, cutoff?: string,
): Map<string, Free[]> {
  const pool = cutoff ? free.filter((f) => f.slot.date <= cutoff) : free.slice();
  const taken = new Set<string>();
  const plan = new Map<string, Free[]>();

  const depths = [...new Set(needs.map((n) => n.depth))].sort((a, b) => a - b);
  for (const depth of depths) {
    const here = needs.filter((n) => n.depth === depth);

    const optionsFor = (n: Need) => {
      const lower = earliestFor(n.divisionId);
      const upper = upperBoundFor(n, plan, restDays);
      return pool.filter((f) => !taken.has(f.id)
        && (!f.slot.ownerDivisionId || f.slot.ownerDivisionId === n.divisionId)
        && f.slot.date >= lower && (!upper || f.slot.date <= upper)).length;
    };
    const order = [...here].sort((a, b) =>
      optionsFor(a) - optionsFor(b) || b.size - a.size
      || a.divisionId.localeCompare(b.divisionId));

    for (const n of order) {
      const lower = earliestFor(n.divisionId);
      const upper = upperBoundFor(n, plan, restDays);
      const open = pool.filter((f) => !taken.has(f.id)
        && (!f.slot.ownerDivisionId || f.slot.ownerDivisionId === n.divisionId)
        && f.slot.date >= lower && (!upper || f.slot.date <= upper));

      // A round belongs on one night where it can: that is how a rink runs a
      // semifinal double-header. Latest such night first, to leave the early
      // nights for the rounds that feed this one.
      let pick: Free[] = [];
      for (const date of [...new Set(open.map((f) => f.slot.date))].sort().reverse()) {
        const night = open.filter((f) => f.slot.date === date);
        if (night.length >= n.size) { pick = night.slice(0, n.size); break; }
      }
      if (!pick.length) {
        pick = open.slice().sort((a, b) => b.key.localeCompare(a.key)).slice(0, n.size)
          .sort((a, b) => a.key.localeCompare(b.key));
      }
      pick.forEach((f) => taken.add(f.id));
      plan.set(keyOf(n), pick);
    }
  }
  return plan;
}

/** The latest date a round may be played: clear of the round it feeds. */
function upperBoundFor(
  n: Need, plan: Map<string, Free[]>, restDays: number,
): string | null {
  const nextRound = plan.get(`${n.divisionId}|${n.roundIdx + 1}`);
  if (!nextRound?.length) return null;
  const firstOfNext = nextRound.map((f) => f.slot.date).sort()[0]!;
  return addDays(firstOfNext, -(1 + restDays));
}

/** The last day each division is still playing its regular season. */
function lastRegularDates(season: Season): Map<string, string> {
  const slotById = new Map(season.slots.map((s) => [s.id, s]));
  const out = new Map<string, string>();
  for (const g of season.games) {
    if (PLAYOFF_TYPES.has(g.type)) continue;
    const date = g.slotId ? slotById.get(g.slotId)?.date : g.away?.date;
    if (!date) continue;
    const cur = out.get(g.divisionId);
    if (!cur || date > cur) out.set(g.divisionId, date);
  }
  return out;
}

function groupByRound(template: BracketNode[]): BracketNode[][] {
  const out = new Map<number, BracketNode[]>();
  for (const n of template) (out.get(n.round) ?? out.set(n.round, []).get(n.round)!).push(n);
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Playable game slots with nothing on them, night by night, from the day
 * after the regular season ends. Pass a division to use ITS last game date
 * rather than the whole league's, which is what the generator does.
 */
export function playoffIceAvailable(
  season: Season, m: LeagueManifest, divisionId?: string,
): { date: string; slots: number }[] {
  const taken = new Set<string>();
  for (const g of season.games) if (g.slotId && !PLAYOFF_TYPES.has(g.type)) taken.add(g.slotId);
  for (const p of season.practices) if (p.teamIds.length) taken.add(p.slotId);

  const lastByDiv = lastRegularDates(season);
  const last = divisionId
    ? lastByDiv.get(divisionId) ?? season.startDate
    : [...lastByDiv.values()].sort().at(-1) ?? season.startDate;

  const byDate = new Map<string, number>();
  for (const s of season.slots) {
    if (!GAME_USES.has(s.use) || taken.has(s.id) || s.date <= last) continue;
    if (divisionId && s.ownerDivisionId && s.ownerDivisionId !== divisionId) continue;
    if (season.blackoutDates.includes(s.date)) continue;
    const wd = weekdayOf(s.date);
    if (m.scheduling.blockedWeekdays.includes(wd)) continue;
    if (m.scheduling.onlyWeekdays.length && !m.scheduling.onlyWeekdays.includes(wd)) continue;
    byDate.set(s.date, (byDate.get(s.date) ?? 0) + 1);
  }
  return [...byDate.entries()].sort().map(([date, slots]) => ({ date, slots }));
}

export type { BracketSize };
