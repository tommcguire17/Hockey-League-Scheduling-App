import type { Season, Slot, Game } from '@league/core';
import type { RepurposeSuggestion } from '@league/core';
import {
  GAMES_PER_SHEET, crossoverPool, gameWhen, PLAYOFF_TYPES, playFloors,
  playableGameIce, playableOn, sameDayVerdict, slotHolds, suggestRepurpose,
} from '@league/core';
import { planPlayoffIce, playoffsFit, type PlayoffIcePlan } from './playoffIce.js';
import {
  type Booked, type LeagueManifest, bandOf, daysBetween, weekKey, weekdayOf,
} from '@league/core';
import { buildFixtures, crossFixtures, type Fixture } from './fixtures.js';
import { mulberry32, shuffled } from './random.js';

export interface GenerateOptions {
  seed?: number;
  /** Hard cap on local-search effort. The search usually stops well before it. */
  iterations?: number;
  /**
   * Give up after this many proposals in a row that fail to improve on the
   * best schedule found. Measured, not guessed: on the real House season
   * every quality measure — longest repeat run, back-to-back rematches,
   * same-opponent-two-apart, late-game spread — is identical at 5,000
   * iterations and at 240,000. The other 235,000 cost eight seconds of a
   * frozen browser to confirm an answer already found.
   */
  stallLimit?: number;
}

export interface GenerateReport {
  placed: number;
  /** Games kept exactly where they were: away fixtures and anything locked. */
  kept: number;
  /** Bracket games left alone. They hold their ice through a regenerate. */
  keptPlayoff: number;
  /** Games against another division, where crossover is turned on. */
  crossGames: number;
  /** Teams that could not get their full share of crossover games. */
  crossShort: { teamId: string; got: number; wanted: number }[];
  /** Games placed into ice reserved for their own division. */
  ownerFirst: number;
  /** Reserved slots that released because their division was already full. */
  ownerReleased: number;
  /** Team-weeks carrying more games than the soft target, and when. */
  busyWeeks: { total: number; worstTeam: number; byMonth: Record<string, number> };
  unplaced: { divisionId: string; homeId: string; awayId: string; reason: string }[];
  byDivision: {
    divisionId: string; teams: number; gamesPerTeam: number;
    fixtures: number; placed: number;
  }[];
  longestRepeatRun: number;
  seed: number;
  /** Local-search moves accepted. Near zero means the search is being vetoed. */
  movesAccepted: number;
  /** Proposals actually tried, against the cap. */
  iterationsRun: number;
  /** True when the search ran out of improvements rather than out of budget. */
  settled: boolean;
  /** Ice that could become the missing games. Proposals only. */
  suggestions: RepurposeSuggestion[];
  /**
   * Ice held back for the brackets, so the regular season does not run to the
   * last night of booked ice and strand the playoffs.
   */
  playoffIce: {
    /** Nights kept clear, earliest first. */
    dates: string[];
    /** Bracket games to be played. */
    games: number;
    /** Bracket games that would find ice on this schedule. */
    placed: number;
    /** True when every bracket game has somewhere to play. */
    sufficient: boolean;
    /** Reserved openings the regular season had to take anyway. */
    taken: number;
    /** Which reserved nights it took them on. */
    nightsTaken: string[];
    /** What is short, in words. */
    issues: string[];
  };
}

export interface GenerateResult { games: Game[]; report: GenerateReport; }

/**
 * One game's worth of ice. A cross-ice sheet runs two games at once, so a
 * slot with capacity 2 offers two openings at the same date and time. The
 * assignment is keyed by opening, not by slot, which is what lets 8U play its
 * twelve cross-ice sessions on twelve sheets rather than twenty-four.
 */
interface Cand { slot: Slot; week: string; key: string; }

function addDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Marker for a conflict caused by a game the generator may not move. */
const FIXED = '__fixed__';

/**
 * Turns slots plus a league manifest into a game list.
 *
 * Pure: same season, same manifest, same seed, same schedule. Honours blackout
 * dates, per-team weekday rules, league weekday rules, one-game-per-week and
 * no-doubleheader, then spreads repeat matchups by local search.
 */
export function generateSchedule(
  season: Season, m: LeagueManifest, opts: GenerateOptions = {},
): GenerateResult {
  const seed = opts.seed ?? 20262027;
  const rnd = mulberry32(seed);
  const iterations = opts.iterations ?? 120000;
  const stallLimit = opts.stallLimit ?? Math.max(5000, Math.floor(iterations / 12));

  const divById = new Map(season.divisions.map((d) => [d.id, d]));
  /** Games of THIS division that fit on this sheet. */
  const holds = (slot: Slot, div: string) => slotHolds(slot, divById.get(div));
  /** The most any division could fit, so the sheet offers enough openings. */
  const widest = Math.max(1, ...season.divisions.map((d) => GAMES_PER_SHEET[d.iceFormat]));

  const allPlayable: Cand[] = playableGameIce(season, m)
    .flatMap((s) => Array.from(
      { length: s.capacity > 0 ? s.capacity : widest }, (_, i) => ({
        slot: s, week: weekKey(s.date, m.week.startsOn), key: `${s.id}#${i}`,
      })))
    .sort((a, b) => (a.slot.date + a.slot.start + a.key)
      .localeCompare(b.slot.date + b.slot.start + b.key));
  let slots: Cand[] = allPlayable;

  /**
   * Nights held back so the brackets have somewhere to play. Planned before
   * anything is placed, because the whole point is to stop the regular season
   * reaching them.
   */
  const reserve: PlayoffIcePlan = planPlayoffIce(season, m);
  const reserved = new Set(reserve.dates);
  /**
   * The last night the regular season may use. Everything that measures how
   * far through the season a date is reads this rather than season.endDate:
   * with a playoff window held back, the final night of the SEASON is a final,
   * and a Saturday two weeks before it is the end of the regular season, not
   * the middle of it. Getting this wrong prices the catch-up doubles as though
   * they were still in midwinter.
   */
  let regularEnd = reserve.dates[0]
    ? allPlayable.filter((c) => !reserved.has(c.slot.date)).at(-1)?.slot.date ?? season.endDate
    : season.endDate;

  /**
   * Evaluations come first: a division does not play until it has been
   * evaluated. This is a floor per division, not a season-wide date, so an
   * age group that finishes evaluating early can start early.
   */
  const floors = playFloors(season);

  const hardWeek = m.scheduling.maxGamesPerWeek;
  const softWeek = Math.min(m.scheduling.softGamesPerWeek, hardWeek);

  /**
   * How much a second game in a week costs, as a multiplier that falls
   * through the season. A double in February is a team catching up; the same
   * double in December is just crowding. Never reaches zero, so the search
   * still prefers not to.
   */
  let seasonDays = Math.max(1, daysBetween(season.startDate, regularEnd));
  const crowding = (date: string) => {
    const through = Math.max(0, Math.min(1, daysBetween(season.startDate, date) / seasonDays));
    return 0.12 + 0.88 * (1 - through) ** 2;
  };

  const teamById = new Map(season.teams.map((t) => [t.id, t]));
  const canPlay = (teamId: string, s: Slot): boolean => {
    const t = teamById.get(teamId);
    if (!t) return false;
    if (t.blackoutDates.includes(s.date)) return false;
    const wd = weekdayOf(s.date);
    if (t.allowedWeekdays.length && !t.allowedWeekdays.includes(wd)) return false;
    return true;
  };

  // ---- games we must not touch ----------------------------------------------
  // An away game is somebody else's booking and a locked game is a decision
  // already made. Both stay exactly where they are, and both still make the
  // teams busy, so the rest of the schedule is built around them.
  const slotById = new Map(season.slots.map((s) => [s.id, s]));
  // A bracket game is a decision already made too: its ice is committed and
  // its matchups come from the standings, not from the fixture list. Leaving
  // it out of `fixed` is how regenerating used to silently delete the playoffs.
  const fixed = season.games.filter(
    (g) => g.away || g.locked || PLAYOFF_TYPES.has(g.type));
  const fixedRegular = fixed.filter((g) => !PLAYOFF_TYPES.has(g.type));
  /**
   * When each kept game is, and how long it runs. The clock matters now, not
   * just the date: whether a second game that day is acceptable depends on
   * the wait between the two, so "team X is busy on the 3rd" is no longer
   * enough to decide anything.
   */
  const fixedBusy: {
    teams: string[]; date: string; week: string; start: string; minutes: number;
  }[] = [];
  const fixedPerSlot = new Map<string, number>();
  /** The division already on a sheet via a kept game: away, locked or bracket. */
  const fixedSlotDiv = new Map<string, string>();
  for (const g of fixed) {
    const w = gameWhen(g, slotById);
    if (!w) continue;
    if (g.slotId) {
      fixedPerSlot.set(g.slotId, (fixedPerSlot.get(g.slotId) ?? 0) + 1);
      fixedSlotDiv.set(g.slotId, g.divisionId);
    }
    fixedBusy.push({
      teams: [g.homeTeamId, g.awayTeamId].filter(Boolean) as string[],
      date: w.date, week: weekKey(w.date, m.week.startsOn),
      start: w.start, minutes: w.minutes,
    });
  }

  // A fixed game consumes ONE opening, not the whole sheet: the other half of
  // a cross-ice slot is still ice we can sell.
  {
    const left = new Map(fixedPerSlot);
    slots = allPlayable.filter((c) => {
      const n = left.get(c.slot.id) ?? 0;
      if (n > 0) { left.set(c.slot.id, n - 1); return false; }
      return true;
    });
  }

  const slotOfCand = new Map(slots.map((c) => [c.key, c]));


  /**
   * The one question the generator ever asks about a candidate placement:
   * what stops these two teams playing in this slot?
   *
   * Returns the ids of the assigned games in the way, or FIXED when the
   * obstacle is a game that may not be moved, or a single FIXED entry for a
   * slot the teams simply cannot use. Empty means go ahead.
   *
   * Every pass used to carry its own copy of this. Three copies of one rule
   * is three chances for them to disagree.
   */
  /**
   * May this division use this slot?
   *
   * `exclusive` never releases. `priority` means the owner gets first refusal
   * and the ice opens up once the owner has no fixtures left to place, which
   * is how a rink actually runs 7am Sunday: 8U's until 8U has its games, then
   * anybody's. Held ice that nobody can ever use is ice sold to no one.
   */
  const afterEvaluation = (slot: Slot, div: string) =>
    playableOn(floors, div, slot.date);

  /**
   * May these two bookings be the same team's day?
   *
   * The weekend double everyone prefers is Saturday and Sunday, and the cost
   * function reaches for that first. This is the other shape: both games on
   * one day, which is worth allowing only when the wait between them is one a
   * family would actually sit through. Outside that window the pair is not a
   * double at all, it is two trips to the rink.
   */
  const sameDayOk = (a: { start: string; minutes: number },
                     b: { start: string; minutes: number }): boolean =>
    m.scheduling.allowSameDayDoubleheader
    && sameDayVerdict(a, b, m.scheduling.sameDayRest) === 'ok';

  const ownerAllows = (slot: Slot, div: string): boolean => {
    const owner = slot.ownerDivisionId;
    if (!owner || owner === div) return true;
    if (slot.ownerPolicy === 'exclusive') return false;
    return ownerSatisfied(owner);
  };

  const blockers = (
    c: Cand, h: string, a: string, div: string,
    current: Map<string, { div: string; fx: Fixture }>, skip?: string,
  ): string[] => {
    if (!afterEvaluation(c.slot, div)) return [FIXED];
    if (!ownerAllows(c.slot, div)) return [FIXED];
    if (!canPlay(h, c.slot) || !canPlay(a, c.slot)) return [FIXED];
    const hits: string[] = [];
    for (const t of [h, a]) {
      // A kept game cannot move, so a bad pairing with one is simply out.
      const already = busyDate.get(c.slot.date)?.get(t);
      if (already?.some((b) => !sameDayOk(b, c.slot))) return [FIXED];
      if (fixedWeekLoad(t, c.week) + 1 > hardWeek) return [FIXED];
    }
    // One sheet, one division. You cannot run an 8U cross-ice game and a 12U
    // full-ice game on the same ice at the same time, and nothing used to say
    // so: the search would happily put two divisions in one slot's openings.
    //
    // A kept game — away, locked or bracket — counts too. It is not in
    // `current`, so checking only the search's own placements left the other
    // half of a cross-ice sheet open to anybody.
    let loadH = fixedWeekLoad(h, c.week);
    let loadA = fixedWeekLoad(a, c.week);
    const weekHits: string[] = [];
    const held = fixedSlotDiv.get(c.slot.id);
    if (held !== undefined && held !== div) return [FIXED];
    let sameSlot = fixedPerSlot.get(c.slot.id) ?? 0;
    if (sameSlot >= holds(c.slot, div)) return [FIXED];
    for (const [sid, it] of current) {
      if (sid === skip || sid === c.key) continue;
      const o = slotOfCand.get(sid);
      if (!o) continue;
      if (o.slot.id === c.slot.id) {
        if (it.div !== div) return [FIXED];
        sameSlot++;
        if (sameSlot >= holds(c.slot, div)) return [FIXED];
      }
      const sameWeek = o.week === c.week, sameDate = o.slot.date === c.slot.date;
      if (!sameWeek && !sameDate) continue;
      const hitsH = it.fx.homeId === h || it.fx.awayId === h;
      const hitsA = it.fx.homeId === a || it.fx.awayId === a;
      if (!hitsH && !hitsA) continue;
      if (sameDate && !sameDayOk(o.slot, c.slot)) { hits.push(sid); continue; }
      if (sameWeek) {
        if (hitsH) loadH++;
        if (hitsA) loadA++;
        weekHits.push(sid);
      }
    }
    // The weekly rule is a ceiling, not a ban: only the games that would push
    // a team past it are in the way.
    if (loadH + 1 > hardWeek || loadA + 1 > hardWeek) hits.push(...weekHits);
    return hits;
  };

  // ---- crossover fixtures ---------------------------------------------------
  // Built once per pool of divisions that have agreed to cross, before the
  // within-division fixtures, because a cross game comes OUT of a team's game
  // total rather than on top of it.
  const divisionOf = new Map(season.teams.map((t) => [t.id, t.divisionId]));
  const crossAll: { div: string; fx: Fixture }[] = [];
  const crossShort: { teamId: string; got: number; wanted: number }[] = [];
  const crossPerTeam = new Map<string, number>();
  {
    const handled = new Set<string>();
    for (const d of season.divisions) {
      if (handled.has(d.id) || d.crossGamesPerTeam <= 0) continue;
      const pool = crossoverPool(season.divisions, d.id);
      for (const x of pool) handled.add(x.id);
      if (pool.length < 2) continue;
      const teams = season.teams
        .filter((t) => pool.some((x) => x.id === t.divisionId))
        .map((t) => ({ id: t.id, divisionId: t.divisionId }));
      const wanted = new Map(teams.map((t) => [
        t.id, pool.find((x) => x.id === t.divisionId)!.crossGamesPerTeam,
      ]));
      const r = crossFixtures(teams, wanted);
      crossShort.push(...r.short);
      for (const fx of r.fixtures) {
        // Filed under the home team's division: a game lives somewhere, and
        // the home side is the one whose ice it is.
        crossAll.push({ div: divisionOf.get(fx.homeId)!, fx });
        for (const t of [fx.homeId, fx.awayId]) {
          crossPerTeam.set(t, (crossPerTeam.get(t) ?? 0) + 1);
        }
      }
    }
  }

  // ---- fixtures per division ------------------------------------------------
  const all: { div: string; fx: Fixture }[] = [...crossAll];
  const byDivision: GenerateReport['byDivision'] = [];
  for (const d of season.divisions) {
    const ids = season.teams.filter((t) => t.divisionId === d.id).map((t) => t.id);
    if (!ids.length) continue;
    const g = d.gamesPerTeam ?? m.scheduling.defaultGamesPerTeam;
    // Whatever the crossover actually delivered comes off the inside-division
    // total, so a team still plays `g` games however the mix worked out.
    const gotCross = Math.min(...ids.map((id) => crossPerTeam.get(id) ?? 0));
    const fx = buildFixtures(ids, Math.max(0, g - gotCross));
    // Drop one fixture per fixed game with the same pairing, so a division's
    // total stays right instead of double-counting what is already arranged.
    const keptHere = fixedRegular.filter((x) => x.divisionId === d.id);
    for (const k of keptHere) {
      const i = fx.findIndex((f) =>
        (f.homeId === k.homeTeamId && f.awayId === k.awayTeamId)
        || (f.homeId === k.awayTeamId && f.awayId === k.homeTeamId));
      if (i >= 0) fx.splice(i, 1);
    }
    for (const f of fx) all.push({ div: d.id, fx: f });
    // A crossover fixture is counted once, under the division it is filed in,
    // so the division's fixtures and placed totals line up.
    const mine = crossAll.filter((c) => c.div === d.id).length;
    byDivision.push({
      divisionId: d.id, teams: ids.length, gamesPerTeam: g,
      fixtures: fx.length + keptHere.length + mine, placed: keptHere.length,
    });
  }

  // ---- how much of the reservation the regular season can afford -----------
  /**
   * The window yields to the regular season rather than starving it.
   *
   * Reserving nights the regular season then has to eat is worse than not
   * reserving them: the two fight, the answer depends on which pass ran last,
   * and the schedule moves around between regenerates for no reason the rink
   * can see. So once the fixture list is known, the earliest reserved nights
   * are handed back until the remaining ice can actually hold the regular
   * season — down to the deepest bracket's round count, which is the smallest
   * window that could ever work, and never below it. Whatever is still short
   * after that is a shortage of booked ice, and is reported as one.
   *
   * The earliest nights go back first because the playoffs want the latest
   * ice: a final belongs on the last weekend, not the first one it can reach.
   */
  const minWindow = Math.max(1, reserve.rounds);
  const held = [...reserve.dates];
  while (held.length > minWindow
    && slots.filter((c) => !held.includes(c.slot.date)).length < all.length) {
    held.shift();
  }
  reserved.clear();
  for (const d of held) reserved.add(d);
  reserve.dates = held;
  // Everything that prices "how late in the season is this" reads the last
  // night the regular season may use, so recompute it against the real window.
  regularEnd = held.length
    ? slots.filter((c) => !reserved.has(c.slot.date)).at(-1)?.slot.date ?? season.endDate
    : season.endDate;
  seasonDays = Math.max(1, daysBetween(season.startDate, regularEnd));

  /**
   * The regular season is placed into everything EXCEPT the reserved nights.
   * `slots` still holds the reserved openings, and still has them last in
   * date order, so the fallback passes can spill into the reserve rather than
   * drop a game when the earlier ice genuinely will not take the season.
   */
  const pool: Cand[] = reserved.size
    ? slots.filter((c) => !reserved.has(c.slot.date))
    : slots;

  // ---- greedy placement, week by week ---------------------------------------
  // Over the pool, not every opening: the reserved nights are the playoffs'.
  const weeks = [...new Set(pool.map((s) => s.week))].sort();
  const slotsByWeek = new Map<string, Cand[]>();
  for (const s of pool) (slotsByWeek.get(s.week) ?? slotsByWeek.set(s.week, []).get(s.week)!).push(s);

  const assign = new Map<string, { div: string; fx: Fixture }>();   // opening -> fixture
  /** Who is on each sheet and how many of them, kept live through the greedy. */
  const slotLoad = new Map<string, { div: string; n: number }>();
  for (const [sid, d] of fixedSlotDiv) {
    slotLoad.set(sid, { div: d, n: fixedPerSlot.get(sid) ?? 1 });
  }
  // Counts, not sets: with a weekly ceiling above one, "this team already has
  // a game that week" is no longer the same as "this team cannot play".
  const busyWeek = new Map<string, Map<string, number>>();   // week -> team -> games
  /** date -> team -> the bookings it already has that day. */
  const busyDate = new Map<string, Map<string, Booked[]>>();
  const noteDay = (date: string, team: string, b: Booked) => {
    const day = busyDate.get(date) ?? busyDate.set(date, new Map()).get(date)!;
    (day.get(team) ?? day.set(team, []).get(team)!).push(b);
  };
  for (const b of fixedBusy) {
    const w = busyWeek.get(b.week) ?? busyWeek.set(b.week, new Map()).get(b.week)!;
    for (const t of b.teams) {
      w.set(t, (w.get(t) ?? 0) + 1);
      noteDay(b.date, t, { start: b.start, minutes: b.minutes });
    }
  }
  const fixedWeekLoad = (team: string, week: string) => busyWeek.get(week)?.get(team) ?? 0;
  const remaining = shuffled(all, rnd);

  /**
   * True once a division has nothing left to place. Read live during the
   * greedy, so reserved ice frees up the moment its owner is done rather
   * than at the end of the run.
   */
  const ownerSatisfied = (div: string) => !remaining.some((r) => r.div === div);
  const lastMet = new Map<string, number>();     // pair key -> index of last placement
  let order = 0;

  for (let wi = 0; wi < weeks.length; wi++) {
    const week = weeks[wi]!;
    const weekSlots = slotsByWeek.get(week)!;
    const playedThisWeek = new Map<string, number>(busyWeek.get(week) ?? []);
    const weekLoad = (t: string) => playedThisWeek.get(t) ?? 0;
    /** What each team is already booked for on each day of this week. */
    const playedThisDate = new Map<string, Map<string, Booked[]>>();
    for (const c of weekSlots) {
      if (playedThisDate.has(c.slot.date)) continue;
      const seed = new Map<string, Booked[]>();
      for (const [t, bs] of busyDate.get(c.slot.date) ?? []) seed.set(t, [...bs]);
      playedThisDate.set(c.slot.date, seed);
    }

    // Spread the season out. Without a quota the greedy fills the first weeks
    // solid and starves the last ones, which is what forces repeat matchups
    // into consecutive weeks.
    //
    // The remainder goes to the LAST weeks, not the first. Rounding up every
    // week put the busy weeks at the front, which is the one place a second
    // game in a week is least welcome: November is not catching up.
    const weeksLeft = weeks.length - wi;
    const even = Math.floor(remaining.length / weeksLeft);
    const extra = remaining.length - even * weeksLeft;
    const quota = Math.min(weekSlots.length, even + (weeksLeft <= extra ? 1 : 0));
    let placedThisWeek = 0;

    for (const cand of weekSlots) {
      if (!remaining.length) break;
      if (placedThisWeek >= quota) break;
      const dayBook = playedThisDate.get(cand.slot.date)!;
      /** Would a second game today be a day worth asking a family to do? */
      const dayOk = (t: string) =>
        (dayBook.get(t) ?? []).every((b) => sameDayOk(b, cand.slot));

      let bestIdx = -1, bestScore = -Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const { div, fx } = remaining[i]!;
        const { homeId: h, awayId: a } = fx;
        if (weekLoad(h) + 1 > hardWeek || weekLoad(a) + 1 > hardWeek) continue;
        if (!dayOk(h) || !dayOk(a)) continue;
        if (!afterEvaluation(cand.slot, div)) continue;
        if (!ownerAllows(cand.slot, div)) continue;
        if (!canPlay(h, cand.slot) || !canPlay(a, cand.slot)) continue;
        const onSheet = slotLoad.get(cand.slot.id);
        if (onSheet && (onSheet.div !== div || onSheet.n >= holds(cand.slot, div))) continue;

        // prefer the pair that has waited longest since it last met, then the
        // division furthest behind its share of the remaining slots
        const key = [h, a].sort().join('|');
        const gap = order - (lastMet.get(key) ?? -999);
        // Reserved ice goes to its owner first. Without this the slot is
        // merely ALLOWED to the owner, and 7am Sunday fills with whoever the
        // search happened to reach first.
        const owned = cand.slot.ownerDivisionId === div ? 10000 : 0;
        // A second game in a week is allowed but not free, and costs most
        // early. The greedy will still take one when nothing better is left,
        // which is the whole point of a soft rule.
        const over = (weekLoad(h) >= softWeek ? 1 : 0) + (weekLoad(a) >= softWeek ? 1 : 0);
        const crowded = over * 900 * crowding(cand.slot.date);
        // Saturday and Sunday beats twice on Sunday, every time. Both are
        // allowed; this is the order to reach for them in.
        const twiceToday = ((dayBook.get(h)?.length ?? 0) > 0 ? 1 : 0)
          + ((dayBook.get(a)?.length ?? 0) > 0 ? 1 : 0);
        const score = owned + gap + rnd() * 0.5 - crowded
          - twiceToday * m.scheduling.sameDayPenalty;
        if (score > bestScore) { bestScore = score; bestIdx = i; }
      }
      if (bestIdx < 0) continue;
      const chosen = remaining.splice(bestIdx, 1)[0]!;
      assign.set(cand.key, chosen);
      const load = slotLoad.get(cand.slot.id);
      if (load) load.n++;
      else slotLoad.set(cand.slot.id, { div: chosen.div, n: 1 });
      for (const t of [chosen.fx.homeId, chosen.fx.awayId]) {
        playedThisWeek.set(t, weekLoad(t) + 1);
      }
      for (const t of [chosen.fx.homeId, chosen.fx.awayId]) {
        (dayBook.get(t) ?? dayBook.set(t, []).get(t)!).push(cand.slot);
      }
      lastMet.set([chosen.fx.homeId, chosen.fx.awayId].sort().join('|'), order++);
      placedThisWeek++;
    }
  }

  /**
   * Fallback: anything still unplaced takes any legal free opening, quota
   * ignored. The week quota is a SOFT target — it spreads the season out,
   * but it must never cost a game.
   */
  const fill = (where: Cand[]) => {
    for (const cand of where) {
      if (!remaining.length) return;
      if (assign.has(cand.key)) continue;
      const pick = remaining.findIndex(
        (r) => blockers(cand, r.fx.homeId, r.fx.awayId, r.div, assign).length === 0);
      if (pick < 0) continue;
      assign.set(cand.key, remaining.splice(pick, 1)[0]!);
    }
  };

  /**
   * Repair. A fixture can be stranded not because the ice is gone but because
   * an earlier placement took the only week both teams were free. So try to
   * MOVE a blocking game to another empty opening, then take its place.
   */
  const repair = (where: Cand[]) => {
    const free = () => where.filter((c) => !assign.has(c.key));
      for (let i = remaining.length - 1; i >= 0; i--) {
        const { div, fx } = remaining[i]!;
        const { homeId: h, awayId: a } = fx;
        let done = false;
        for (const target of free()) {
          if (done) break;
          if (!afterEvaluation(target.slot, div)) continue;
          if (!ownerAllows(target.slot, div)) continue;
          if (!canPlay(h, target.slot) || !canPlay(a, target.slot)) continue;
          const blocked = blockers(target, h, a, div, assign);
          // A fixed game cannot be moved aside, so this slot is simply out.
          if (blocked.includes(FIXED)) continue;
          if (blocked.length !== 1) continue;            // only simple cases
          const blockerId = blocked[0]!;
          const blocker = assign.get(blockerId)!;
          // can the blocker move somewhere else?
          for (const alt of free()) {
            if (alt.key === target.key) continue;
            if (!afterEvaluation(alt.slot, blocker.div)) continue;
            if (!ownerAllows(alt.slot, blocker.div)) continue;
            if (!canPlay(blocker.fx.homeId, alt.slot) || !canPlay(blocker.fx.awayId, alt.slot)) continue;
            // Make BOTH moves, then check. Checking them one at a time, before
            // the other is in place, means the two are never tested against
            // each other — which is how the same pairing ended up twice on one
            // day, each half of the move legal on its own.
            assign.delete(blockerId);
            assign.set(alt.key, blocker);
            assign.set(target.key, { div, fx });
            const ok = blockers(alt, blocker.fx.homeId, blocker.fx.awayId,
              blocker.div, assign, alt.key).length === 0
              && blockers(target, h, a, div, assign, target.key).length === 0;
            if (!ok) {
              assign.delete(alt.key);
              assign.delete(target.key);
              assign.set(blockerId, blocker);
              continue;
            }
            remaining.splice(i, 1);
            done = true;
            break;
          }
        }
      }
  };

  /**
   * Spend the regular season's own ice first — every sheet of it, including
   * the ones that only work once a game is moved aside — and only then touch
   * a night held back for the playoffs.
   *
   * Reaching the window last in DATE order is not enough, and that was the
   * bug: the fallback pass would refuse a January sheet because one game that
   * afternoon was in the way, walk on, and spend a March night it could never
   * give back. A repair that frees January costs nothing; a March night costs
   * the brackets. So both passes run over the pool before either sees the
   * window.
   *
   * The window is still used in the end rather than dropping a fixture. Ice
   * short for the playoffs is a problem the rink can solve by booking more,
   * and it is reported as one; a regular-season game quietly deleted is not a
   * problem it can see.
   */
  if (remaining.length) fill(pool);
  if (remaining.length) repair(pool);
  if (remaining.length) fill(slots);
  if (remaining.length) repair(slots);

  // ---- local search: spread repeat matchups, even out start times -----------
  const slotOf = slotOfCand;
  const placedIds = [...assign.keys()];

  /**
   * Reserved ice the owner actually took. By now every fixture is placed, so
   * ownerAllows() would wave anyone through and the search would happily
   * trade an 8U game out of 7am Sunday. Freeze what the owner won.
   */
  const ownerHeld = new Set<string>();
  for (const [key, it] of assign) {
    const slot = slotOf.get(key)?.slot;
    if (slot?.ownerDivisionId && slot.ownerDivisionId === it.div) ownerHeld.add(key);
  }

  const legal = (slotId: string, item: { div: string; fx: Fixture },
                 a: Map<string, { div: string; fx: Fixture }>): boolean => {
    const cand = slotOf.get(slotId)!;
    if (ownerHeld.has(slotId) && cand.slot.ownerDivisionId !== item.div) return false;
    return blockers(cand, item.fx.homeId, item.fx.awayId, item.div, a, slotId).length === 0;
  };

  const lateSeasonFrom = 0.75;        // matches the validator's own threshold
  const through = (date: string) =>
    Math.max(0, Math.min(1, daysBetween(season.startDate, date) / seasonDays));

  /**
   * Everything about an opening that never changes, worked out once.
   *
   * The cost function runs tens of thousands of times and used to re-derive
   * all of this on every call, sorting each team's games by a "YYYY-MM-DDHH:MM"
   * string. Sorting integers instead, and looking the rest up, is most of
   * what the search spends its time on.
   */
  interface Fixed {
    rank: number; day: number; band: string; week: string; crowd: number;
  }
  const facts = new Map<string, Fixed>();
  {
    const ordered = [...slots].sort((x, y) =>
      (x.slot.date + x.slot.start).localeCompare(y.slot.date + y.slot.start));
    ordered.forEach((c, i) => facts.set(c.key, {
      rank: i,
      day: daysBetween(season.startDate, c.slot.date),
      band: bandOf(c.slot.start, m.timeBands),
      week: c.week,
      crowd: crowding(c.slot.date),
    }));
  }

  const checkDays = m.scheduling.allowConsecutiveDays !== 'always';
  const consecutiveNever = m.scheduling.allowConsecutiveDays === 'never';
  const lateDay = seasonDays * lateSeasonFrom;

  const sameDayCost = m.scheduling.allowSameDayDoubleheader
    ? m.scheduling.sameDayPenalty : 0;

  const cost = (a: Map<string, { div: string; fx: Fixture }>): number => {
    const seq = new Map<string, { rank: number; day: number; opp: string }[]>();
    const lateCount = new Map<string, number>();
    const load = new Map<string, number>();        // "team|week" -> games
    const crowd = new Map<string, number>();       // "team|week" -> price of a double
    for (const [sid, it] of a) {
      const f = facts.get(sid)!;
      for (const [me, them] of [[it.fx.homeId, it.fx.awayId], [it.fx.awayId, it.fx.homeId]] as const) {
        (seq.get(me) ?? seq.set(me, []).get(me)!).push({ rank: f.rank, day: f.day, opp: them });
        if (f.band === 'evening') lateCount.set(me, (lateCount.get(me) ?? 0) + 1);
        const k = `${me}|${f.week}`;
        load.set(k, (load.get(k) ?? 0) + 1);
        crowd.set(k, f.crowd);
      }
    }
    let c = 0;
    for (const [, lst] of seq) {
      lst.sort((x, y) => x.rank - y.rank);
      for (let i = 1; i < lst.length; i++) if (lst[i]!.opp === lst[i - 1]!.opp) c += 5000;
      for (let i = 2; i < lst.length; i++) if (lst[i]!.opp === lst[i - 2]!.opp) c += 200;
      for (let i = 3; i < lst.length; i++) if (lst[i]!.opp === lst[i - 3]!.opp) c += 40;

      // Twice on one day. Legal only within the rest window by this point,
      // so this is not a ban — it is the preference for splitting the pair
      // across Saturday and Sunday when both arrangements would work.
      if (sameDayCost) {
        for (let i = 1; i < lst.length; i++) {
          if (lst[i]!.day === lst[i - 1]!.day) c += sameDayCost;
        }
      }

      // Back-to-back days. Loosening the weekly rule without this is what
      // answers a second game in the week with the very next morning.
      if (checkDays) {
        for (let i = 1; i < lst.length; i++) {
          if (lst[i]!.day - lst[i - 1]!.day !== 1) continue;
          c += (consecutiveNever || lst[i]!.day <= lateDay) ? 1200 : 150;
        }
      }
    }

    // A second game in a week, priced by when it falls, plus a fairness term
    // so the doubles do not all land on the same unlucky team.
    const extras = new Map<string, number>();
    for (const [k, n] of load) {
      if (n <= softWeek) continue;
      const over = n - softWeek;
      const team = k.slice(0, k.indexOf('|'));
      extras.set(team, (extras.get(team) ?? 0) + over);
      c += over * 2200 * crowd.get(k)!;
    }
    if (softWeek < hardWeek) {
      let hi = 0, lo = Infinity;
      for (const t of seq.keys()) {
        const n = extras.get(t) ?? 0;
        if (n > hi) hi = n;
        if (n < lo) lo = n;
      }
      if (lo !== Infinity) c += (hi - lo) ** 2 * 120;
    }

    // even spread of late starts
    let hi = 0, lo = Infinity;
    for (const t of seq.keys()) {
      const n = lateCount.get(t) ?? 0;
      if (n > hi) hi = n;
      if (n < lo) lo = n;
    }
    if (lo !== Infinity) c += (hi - lo) ** 2 * 30;
    return c;
  };

  // Swapping two games in DIFFERENT weeks is nearly always rejected, because
  // one of the four teams usually already plays in the target week. Swapping
  // within a week is always week-legal, so most proposals come from there.
  const idsByWeek = new Map<string, string[]>();
  for (const id of placedIds) {
    const w = slotOf.get(id)!.week;
    (idsByWeek.get(w) ?? idsByWeek.set(w, []).get(w)!).push(id);
  }
  const swappableWeeks = [...idsByWeek.values()].filter((v) => v.length > 1);

  let cur = new Map(assign);
  let curCost = cost(cur);
  let best = new Map(cur), bestCost = curCost;
  let accepted = 0;
  let sinceBest = 0;
  let ran = 0;
  for (let it = 0; it < iterations; it++) {
    ran = it + 1;
    if (sinceBest >= stallLimit) break;
    sinceBest++;
    const T = 500 * Math.pow(0.4 / 500, it / iterations);
    let i: string, j: string;
    if (swappableWeeks.length && rnd() < 0.7) {
      const w = swappableWeeks[Math.floor(rnd() * swappableWeeks.length)]!;
      i = w[Math.floor(rnd() * w.length)]!;
      j = w[Math.floor(rnd() * w.length)]!;
    } else {
      i = placedIds[Math.floor(rnd() * placedIds.length)]!;
      j = placedIds[Math.floor(rnd() * placedIds.length)]!;
    }
    if (i === j) continue;
    const next = new Map(cur);
    const a = next.get(i)!, b = next.get(j)!;
    next.set(i, b); next.set(j, a);
    if (!legal(i, b, next) || !legal(j, a, next)) continue;
    const nc = cost(next);
    if (nc <= curCost || rnd() < Math.exp((curCost - nc) / Math.max(T, 1e-9))) {
      cur = next; curCost = nc; accepted++;
      if (nc < bestCost) { best = new Map(next); bestCost = nc; sinceBest = 0; }
    }
  }

  // ---- emit ------------------------------------------------------------------
  const games: Game[] = fixed.map((g) => ({ ...g }));
  // Numbering from the count of kept games collides with them as soon as the
  // generated range reaches their ids: a season whose playoff games are
  // g121..g130 handed out g121 again the moment it placed 121 games. Skip
  // anything already taken instead of assuming the kept ids are low.
  const usedIds = new Set(games.map((g) => g.id));
  let n = 0;
  const nextId = (): string => {
    let id = '';
    do { id = `g${String(++n).padStart(3, '0')}`; } while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };
  for (const c of slots) {
    const it = best.get(c.key);
    if (!it) continue;
    games.push({
      id: nextId(), divisionId: it.div, slotId: c.slot.id,
      homeTeamId: it.fx.homeId, awayTeamId: it.fx.awayId,
      homeLabel: '', awayLabel: '', homeFrom: null, awayFrom: null,
      type: 'regular', homeGoals: null, awayGoals: null,
      away: null, locked: false,
    });
    const row = byDivision.find((d) => d.divisionId === it.div);
    if (row) row.placed++;
  }

  const placedKeys = new Set(games.map((g) => `${g.divisionId}|${g.homeTeamId}|${g.awayTeamId}`));
  const counted = new Map<string, number>();
  for (const g of games) {
    const k = `${g.divisionId}|${g.homeTeamId}|${g.awayTeamId}`;
    counted.set(k, (counted.get(k) ?? 0) + 1);
  }
  /**
   * Ice the rink marked as the playoffs' own. The regular season cannot
   * reach it, which is the whole point of marking it — but when that is why
   * a fixture has nowhere to play, the fixture should say so. "No legal slot
   * left under the one-game-per-week rule" sends you looking at the weekly
   * rule, and the answer is a decision you made on the Booked Ice tab.
   */
  const markedNights = [...new Set(
    season.slots.filter((x) => x.use === 'playoff').map((x) => x.date))].sort();
  const unplaced = remaining.map((r) => ({
    divisionId: r.div, homeId: r.fx.homeId, awayId: r.fx.awayId,
    reason: markedNights.length
      ? `no ice left before ${markedNights[0]}, which is where the playoff ice you `
        + `marked begins (${markedNights.length} night(s)). Un-mark a night, or play `
        + 'fewer games per team.'
      : floors.has(r.div)
        ? `no legal slot left after ${r.div}'s evaluations on ${floors.get(r.div)}, `
          + 'under the one-game-per-week and blackout rules'
        : 'no legal slot left under the one-game-per-week and blackout rules',
  }));
  const shortBy = new Map<string, number>();
  for (const u of unplaced) shortBy.set(u.divisionId, (shortBy.get(u.divisionId) ?? 0) + 1);
  const suggestions: RepurposeSuggestion[] = [];
  for (const [div, n] of shortBy) {
    const floor = floors.get(div);
    suggestions.push(...suggestRepurpose(season, m, {
      use: 'game', count: n, divisionId: div,
      from: floor ? addDay(floor) : undefined,
      reason: `${div} has ${n} game(s) with nowhere to play`,
    }));
  }
  void placedKeys;

  // longest run of the same opponent, in date order across home and away alike
  const seq = new Map<string, { t: string; opp: string }[]>();
  for (const g of games) {
    const w = gameWhen(g, slotById);
    if (!w || !g.homeTeamId || !g.awayTeamId) continue;
    if (PLAYOFF_TYPES.has(g.type)) continue;   // a bracket rematch is not a run
    const t = w.date + w.start;
    (seq.get(g.homeTeamId) ?? seq.set(g.homeTeamId, []).get(g.homeTeamId)!).push({ t, opp: g.awayTeamId });
    (seq.get(g.awayTeamId) ?? seq.set(g.awayTeamId, []).get(g.awayTeamId)!).push({ t, opp: g.homeTeamId });
  }
  let longest = 1;
  for (const [, lst] of seq) {
    lst.sort((a, b) => a.t.localeCompare(b.t));
    let run = 1;
    for (let i = 1; i < lst.length; i++) {
      run = lst[i]!.opp === lst[i - 1]!.opp ? run + 1 : 1;
      if (run > longest) longest = run;
    }
  }

  // How often the soft weekly rule was bent, so it is visible rather than
  // something you would have to go and count.
  const weekTally = new Map<string, Map<string, number>>();
  /** Which month a scheduling week's games mostly fall in. */
  const monthOfWeek = new Map<string, string>();
  for (const g of games) {
    const w = gameWhen(g, slotById);
    if (!w || PLAYOFF_TYPES.has(g.type)) continue;
    const wk = weekKey(w.date, m.week.startsOn);
    if (!monthOfWeek.has(wk)) monthOfWeek.set(wk, w.date.slice(0, 7));
    for (const t of [g.homeTeamId, g.awayTeamId]) {
      if (!t) continue;
      const lm = weekTally.get(t) ?? weekTally.set(t, new Map()).get(t)!;
      lm.set(wk, (lm.get(wk) ?? 0) + 1);
    }
  }
  const perTeamExtra = new Map<string, number>();
  const byMonth: Record<string, number> = {};
  for (const [team, byWeek] of weekTally) {
    for (const [wk, n] of byWeek) {
      if (n <= softWeek) continue;
      perTeamExtra.set(team, (perTeamExtra.get(team) ?? 0) + 1);
      // The month the games are actually in, not the month the week key
      // happens to start in: a Saturday double on 5 December belongs under
      // December, and reporting it as November is just confusing.
      byMonth[monthOfWeek.get(wk) ?? wk.slice(0, 7)]
        = (byMonth[monthOfWeek.get(wk) ?? wk.slice(0, 7)] ?? 0) + 1;
    }
  }
  const busyWeeks = {
    total: [...perTeamExtra.values()].reduce((x, y) => x + y, 0),
    worstTeam: Math.max(0, ...perTeamExtra.values()),
    byMonth,
  };

  let ownerFirst = 0, ownerReleased = 0;
  for (const c of slots) {
    const it = best.get(c.key);
    const owner = c.slot.ownerDivisionId;
    if (!owner || !it) continue;
    if (it.div === owner) ownerFirst++;
    else ownerReleased++;
  }

  // How much of the playoff window the regular season had to eat. Zero is the
  // normal answer; anything else means the booked game ice does not cover the
  // season the league has promised, and no amount of compacting changes that.
  const ateNights = new Set<string>();
  let ate = 0;
  for (const c of slots) {
    if (!reserved.has(c.slot.date) || !best.has(c.key)) continue;
    ate++;
    ateNights.add(c.slot.date);
  }
  /**
   * Whether the brackets survived — asked, not estimated.
   *
   * Counting openings held back against openings taken gets this wrong in
   * both directions, because WHICH opening was taken matters as much as how
   * many: a night the brackets never wanted costs nothing, and the one night
   * a division could have played its semifinal costs everything. So the
   * finished schedule goes back to the allocator and the answer is whatever
   * it says.
   */
  const fit = playoffsFit({ ...season, games }, m);
  const playoffIssues = [...(fit.fits ? [] : reserve.issues)];
  const playoffShort = Math.max(0, fit.needed - fit.placed);

  if (playoffShort) {
    // Say the arithmetic out loud. A schedule that quietly drops the brackets
    // is the bug Tom hit; a schedule that says "you are nine openings short,
    // and here are nine practice slots to flip" is a decision he can make.
    const demand = all.length + fixedRegular.length + fit.needed;
    /**
     * Openings the rink really has, not the openings the search was offered.
     * `allPlayable` gives every sheet as many openings as the WIDEST division
     * could use, because a cross-ice division might take it; a full-ice
     * league can only ever use one of them. Reporting that number told Tom
     * his rink had 262 openings for a 132-game season, which is both wrong
     * and the opposite of the point being made.
     */
    const booked = playableGameIce(season, m).reduce((n, x) => {
      if (x.capacity > 0) return n + x.capacity;
      const d = x.ownerDivisionId ? divById.get(x.ownerDivisionId) : undefined;
      return n + (d ? GAMES_PER_SHEET[d.iceFormat] : 1);
    }, 0);
    playoffIssues.push(`${playoffShort} of ${fit.needed} playoff game(s) have nowhere to `
      + `play. The season needs ${demand} game(s) on ice — `
      + `${all.length + fixedRegular.length} regular and ${fit.needed} playoff — against the `
      + `${booked} the rink has booked.`);
    if (ate) {
      playoffIssues.push(`The regular season had to take ${ate} opening(s) on `
        + `${ateNights.size} night(s) held back for the playoffs `
        + `(${[...ateNights].sort().join(', ')}). `
        + (softWeek < hardWeek
          ? 'Two games in a week is already being used to compact it.'
          : `${m.name} allows one game a week, so the season cannot be compacted further.`));
    }
    playoffIssues.push(`Flipping ${playoffShort} slot(s) to game ice on or after `
      + `${reserve.dates[0] ?? regularEnd} would cover it. The practice nights after the `
      + 'regular season ends are the obvious candidates: nobody is practising once the '
      + 'season is over.');
    suggestions.push(...suggestRepurpose(season, m, {
      use: 'game', count: playoffShort,
      from: reserve.dates[0] ?? regularEnd,
      reason: `the playoffs are ${playoffShort} game opening(s) short of ice`,
    }));
  }

  return {
    games,
    report: {
      placed: games.length, kept: fixedRegular.length,
      keptPlayoff: fixed.length - fixedRegular.length, unplaced, byDivision,
      crossGames: crossAll.length, crossShort,
      ownerFirst, ownerReleased, busyWeeks, iterationsRun: ran, settled: sinceBest >= stallLimit,
      suggestions: suggestions.filter(
        (s2, i, all) => all.findIndex((x) => x.slotId === s2.slotId) === i),
      longestRepeatRun: longest, seed,
      movesAccepted: accepted,
      playoffIce: {
        dates: reserve.dates,
        games: fit.needed,
        sufficient: playoffShort === 0,
        placed: fit.placed,
        taken: ate,
        nightsTaken: [...ateNights].sort(),
        issues: playoffIssues,
      },
    },
  };
}
