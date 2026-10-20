import type { Season, Game, GameType, Slot } from './schema.js';
import {
  FORMAT_LABEL, crossoverPool, gameWhen, mayCross, PLAYOFF_TYPES, slotHolds,
} from './schema.js';
import { BRACKET_SIZES, isBracketSize, ROUND_LABELS, codeOfGameId } from './playoffs.js';
import { playFloors } from './evaluations.js';
import type { LeagueManifest } from './manifest.js';
import {
  SAME_DAY_REASON, bandOf, daysBetween, fmtTime, minutesOf, sameDayVerdict, weekKey,
  weekdayOf, type TimeBand,
} from './time.js';

export type Severity = 'error' | 'warning' | 'info';

export interface Violation {
  code: string;
  severity: Severity;
  message: string;
  /** What the violation is about: a team id, slot id, game id, division id. */
  subject?: string;
  date?: string;
}

export interface TeamReport {
  teamId: string;
  teamName: string;
  divisionId: string;
  games: number;
  gamesTarget: number;
  awayGames: number;
  practices: number;
  practicesTarget: number;
  evaluations: number;
  bands: Record<TimeBand, number>;
  sameDayGameDates: string[];
  gameAndPracticeDates: string[];
  longestRepeatRun: number;
  opponents: string[];
}

export interface ValidationResult {
  violations: Violation[];
  teams: TeamReport[];
  ok: boolean;
  errorCount: number;
  warningCount: number;
}

/** Minutes needed between two bookings on one sheet to clear and cut the ice. */
export const MIN_TURNAROUND = 10;

const roundName = (t: string) => ROUND_LABELS[t] ?? t;
const shortCode = (gameId: string) => codeOfGameId(gameId).toUpperCase();

const hhmm = (m: number) =>
  `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * Pure. Takes a season and its league manifest, returns everything that is
 * wrong and a per-team report. No I/O, no randomness, no clock.
 */
export function validateSeason(season: Season, m: LeagueManifest): ValidationResult {
  const v: Violation[] = [];
  const add = (
    code: string, severity: Severity, message: string, subject?: string, date?: string,
  ) => v.push({ code, severity, message, subject, date });

  const slotById = new Map(season.slots.map((s) => [s.id, s]));
  const teamById = new Map(season.teams.map((t) => [t.id, t]));
  const divById = new Map(season.divisions.map((d) => [d.id, d]));

  // --- structural integrity -------------------------------------------------
  for (const [label, ids] of [
    ['slot', season.slots.map((s) => s.id)],
    ['team', season.teams.map((t) => t.id)],
    ['division', season.divisions.map((d) => d.id)],
    ['game', season.games.map((g) => g.id)],
    ['practice', season.practices.map((p) => p.id)],
  ] as const) {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) add('DUPLICATE_ID', 'error', `Duplicate ${label} id "${id}".`, id);
      seen.add(id);
    }
  }
  for (const t of season.teams) {
    if (!divById.has(t.divisionId)) {
      add('ORPHAN_TEAM', 'error', `Team "${t.name}" points at unknown division "${t.divisionId}".`, t.id);
    }
  }

  if (m.unknowns.length) {
    for (const u of m.unknowns) {
      add('MANIFEST_UNKNOWN', 'warning', `${m.name}: ${u}`, m.id);
    }
  }

  // --- capability gates -----------------------------------------------------
  if (!m.capabilities.practices && season.practices.length > 0) {
    add('PRACTICES_NOT_SUPPORTED', 'error',
      `${m.name} has practices turned off but the season carries ${season.practices.length} practices.`);
  }
  if (!m.capabilities.crossIce) {
    for (const s of season.slots) {
      if (slotHolds(s, divById.get(s.ownerDivisionId ?? '')) > 1) {
        add('CROSS_ICE_NOT_SUPPORTED', 'error',
          `Slot ${s.date} ${s.start} would hold more than one game but ${m.name} does not `
          + 'split the ice.',
          s.id, s.date);
      }
    }
  }

  // --- slot occupancy -------------------------------------------------------
  // A game must have our ice or an away venue, not both and not neither.
  for (const g of season.games) {
    if (g.slotId && g.away) {
      add('GAME_BOTH_HOME_AND_AWAY', 'error',
        `Game ${g.id} has both a home slot and an away venue. It can only have one.`, g.id);
    }
    if (!g.slotId && !g.away && g.type === 'regular') {
      add('GAME_UNPLACED', 'warning',
        `Game ${g.id} has no ice and no away venue yet.`, g.id);
    }
  }

  const gamesInSlot = new Map<string, Game[]>();
  for (const g of season.games) {
    if (!g.slotId) continue;
    const slot = slotById.get(g.slotId);
    if (!slot) {
      add('GAME_ORPHAN_SLOT', 'error', `Game ${g.id} points at unknown slot "${g.slotId}".`, g.id);
      continue;
    }
    (gamesInSlot.get(g.slotId) ?? gamesInSlot.set(g.slotId, []).get(g.slotId)!).push(g);
  }
  for (const [slotId, gs] of gamesInSlot) {
    const slot = slotById.get(slotId)!;
    // One sheet, one division: you cannot run an 8U cross-ice game and a 12U
    // full-ice game on the same ice at the same time.
    const divs = [...new Set(gs.map((g) => g.divisionId))];
    if (divs.length > 1) {
      add('SLOT_SPLIT_BETWEEN_DIVISIONS', 'error',
        `${slot.date} ${slot.start} ${slot.rink}: `
        + `${divs.map((x) => divById.get(x)?.name ?? x).join(' and ')} are both on this sheet. `
        + 'A sheet is set up one way at a time.', slotId, slot.date);
    }
    const holds = slotHolds(slot, divById.get(divs[0] ?? ''));
    if (gs.length > holds) {
      const d = divById.get(divs[0] ?? '');
      add('SLOT_OVERBOOKED', 'error',
        `${slot.date} ${slot.start} ${slot.rink}: ${gs.length} games on a sheet that holds `
        + `${holds}${d && slot.capacity === 0 ? ` (${FORMAT_LABEL[d.iceFormat].toLowerCase()})` : ''}.`,
        slotId, slot.date);
    }
    if (slot.use === 'practice' && m.scheduling.gamesOnPracticeIce === 'never') {
      add('GAME_ON_PRACTICE_ICE', 'error',
        `${slot.date} ${slot.start}: game scheduled on practice ice, which ${m.name} forbids.`,
        slotId, slot.date);
    } else if (slot.use === 'practice') {
      add('GAME_ON_PRACTICE_ICE', 'warning',
        `${slot.date} ${slot.start}: game is using practice ice.`, slotId, slot.date);
    }
    if (slot.use === 'unused') {
      add('GAME_ON_UNUSED_ICE', 'error',
        `${slot.date} ${slot.start}: game scheduled on a slot marked out of play.`, slotId, slot.date);
    }
    // Playoff ice is the rink's statement about where the season ends. A
    // regular-season game on it is that statement being broken, and it is
    // worth saying plainly rather than leaving it to show up later as a
    // bracket with nowhere to play.
    if (slot.use === 'playoff') {
      const regular = gs.filter((g) => !PLAYOFF_TYPES.has(g.type));
      for (const g of regular) {
        add('REGULAR_ON_PLAYOFF_ICE', 'error',
          `${slot.date} ${slot.start}: a regular-season game is on ice held for the `
          + 'playoffs. Move it, or change the slot\'s use on Booked Ice.', g.id, slot.date);
      }
    }
  }
  for (const p of season.practices) {
    const slot = slotById.get(p.slotId);
    if (!slot) {
      add('PRACTICE_ORPHAN_SLOT', 'error', `Practice ${p.id} points at unknown slot "${p.slotId}".`, p.id);
      continue;
    }
    // practiceTeams 0 means auto: the slot takes whatever its division needs.
    // An evaluation is the whole age group on the ice at once, so a sharing
    // cap meant for practices does not apply to it.
    if (p.kind !== 'evaluation' && slot.practiceTeams > 0
      && p.teamIds.length > slot.practiceTeams) {
      add('PRACTICE_OVERBOOKED', 'error',
        `${slot.date} ${slot.start}: ${p.teamIds.length} teams in a practice slot that holds ${slot.practiceTeams}.`,
        p.id, slot.date);
    }
    if (slot.use !== 'practice' && slot.use !== 'evaluation') {
      add('PRACTICE_ON_GAME_ICE', 'warning',
        `${slot.date} ${slot.start}: a ${p.kind} is booked on ice marked "${slot.use}".`,
        p.id, slot.date);
    }
    if (slot.use === 'evaluation' && p.kind !== 'evaluation') {
      add('PRACTICE_ON_EVALUATION_ICE', 'warning',
        `${slot.date} ${slot.start}: a practice is booked on evaluation ice.`, p.id, slot.date);
    }
  }

  // --- per-team analysis ----------------------------------------------------
  type Appearance = {
    date: string; start: string; minutes: number;
    opponentId: string | null; type: GameType; away: boolean;
  };
  const gameApps = new Map<string, Appearance[]>();
  const practiceDates = new Map<string, string[]>();
  const evalDates = new Map<string, string[]>();
  for (const t of season.teams) {
    gameApps.set(t.id, []); practiceDates.set(t.id, []); evalDates.set(t.id, []);
  }

  for (const g of season.games) {
    const when = gameWhen(g, slotById);
    if (!when) continue;
    for (const [me, them] of [
      [g.homeTeamId, g.awayTeamId], [g.awayTeamId, g.homeTeamId],
    ] as const) {
      if (!me) continue;
      const list = gameApps.get(me);
      if (!list) {
        add('GAME_ORPHAN_TEAM', 'error', `Game ${g.id} references unknown team "${me}".`, g.id);
        continue;
      }
      list.push({
        date: when.date, start: when.start, minutes: when.minutes,
        opponentId: them, type: g.type, away: when.away,
      });
    }
  }
  for (const p of season.practices) {
    const slot = slotById.get(p.slotId);
    if (!slot) continue;
    const target = p.kind === 'evaluation' ? evalDates : practiceDates;
    for (const tid of p.teamIds) {
      const list = target.get(tid);
      if (!list) {
        add('PRACTICE_ORPHAN_TEAM', 'error', `Practice ${p.id} references unknown team "${tid}".`, p.id);
        continue;
      }
      list.push(slot.date);
    }
  }

  const reports: TeamReport[] = [];
  for (const t of season.teams) {
    const div = divById.get(t.divisionId);
    const gTarget = div?.gamesPerTeam ?? m.scheduling.defaultGamesPerTeam;
    const pTarget = m.capabilities.practices
      ? (div?.practicesPerTeam ?? m.scheduling.defaultPracticesPerTeam) : 0;

    const apps = (gameApps.get(t.id) ?? []).slice()
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    const regular = apps.filter((a) => !PLAYOFF_TYPES.has(a.type));
    const pDates = practiceDates.get(t.id) ?? [];
    const eDates = evalDates.get(t.id) ?? [];

    const bands: Record<TimeBand, number> = { morning: 0, midday: 0, evening: 0 };
    for (const a of apps) bands[bandOf(a.start, m.timeBands)]++;

    /**
     * Two games in a day.
     *
     * Where the league bans them outright, any pair is an error. Where it
     * allows one — the weekend double a rink makes deliberately to fit a
     * season into the ice it has — the question is no longer whether but
     * how: games that overlap are impossible, and a pair with no break
     * between them or a three-hour wait in the middle is a day nobody asked
     * for. Three games is past arguing about.
     */
    const byDate = new Map<string, Appearance[]>();
    for (const a of apps) (byDate.get(a.date) ?? byDate.set(a.date, []).get(a.date)!).push(a);
    const sameDay = [...byDate.entries()].filter(([, l]) => l.length > 1).map(([d]) => d);
    for (const [d, list] of byDate) {
      if (list.length < 2) continue;
      if (!m.scheduling.allowSameDayDoubleheader) {
        add('SAME_DAY_DOUBLEHEADER', 'error',
          `${t.name} plays twice on ${d}, which ${m.name} does not allow.`, t.id, d);
        continue;
      }
      if (list.length > 2) {
        add('SAME_DAY_DOUBLEHEADER', 'error',
          `${t.name} plays ${list.length} games on ${d}.`, t.id, d);
        continue;
      }
      const [first, second] = [...list]
        .sort((a, b) => minutesOf(a.start) - minutesOf(b.start)) as [Appearance, Appearance];
      const verdict = sameDayVerdict(first, second, m.scheduling.sameDayRest);
      if (verdict === 'ok') continue;
      add('SAME_DAY_GAP', verdict === 'overlaps' ? 'error' : 'warning',
        `${t.name} plays twice on ${d} — ${fmtTime(first.start)} and `
        + `${fmtTime(second.start)} — with ${SAME_DAY_REASON[verdict]}.`, t.id, d);
    }

    // game and practice on one day
    const pSet = new Set(pDates);
    const both = [...new Set(apps.map((a) => a.date))].filter((d) => pSet.has(d)).sort();
    if (both.length && !m.scheduling.allowGameAndPracticeSameDay) {
      for (const d of both) {
        add('GAME_AND_PRACTICE_SAME_DAY', 'error',
          `${t.name} has a game and a practice on ${d}.`, t.id, d);
      }
    }

    // blackout dates and weekday restrictions
    for (const a of apps) {
      if (a.away) {
        // Only the team's own availability binds for a game at another rink.
        if (t.blackoutDates.includes(a.date)) {
          add('BLACKOUT_VIOLATED', 'error',
            `${t.name} has an away game on its blackout date ${a.date}.`, t.id, a.date);
        }
        continue;
      }
      if (season.blackoutDates.includes(a.date)) {
        add('LEAGUE_BLACKOUT_VIOLATED', 'error',
          `${t.name} is scheduled on ${a.date}, a league-wide blackout date.`, t.id, a.date);
      }
      if (t.blackoutDates.includes(a.date)) {
        add('BLACKOUT_VIOLATED', 'error', `${t.name} is scheduled on its blackout date ${a.date}.`, t.id, a.date);
      }
      const wd = weekdayOf(a.date);
      if (t.allowedWeekdays.length && !t.allowedWeekdays.includes(wd)) {
        add('TEAM_WEEKDAY_VIOLATED', 'error',
          `${t.name} is scheduled on a ${wd} but may only play ${t.allowedWeekdays.join(', ')}.`, t.id, a.date);
      }
      if (m.scheduling.blockedWeekdays.includes(wd)) {
        add('LEAGUE_WEEKDAY_BLOCKED', 'error',
          `${t.name} is scheduled on a ${wd}; ${m.name} never plays that day.`, t.id, a.date);
      }
      if (m.scheduling.onlyWeekdays.length && !m.scheduling.onlyWeekdays.includes(wd)) {
        add('LEAGUE_WEEKDAY_NOT_ALLOWED', 'error',
          `${t.name} is scheduled on a ${wd}; ${m.name} plays only on ` +
          `${m.scheduling.onlyWeekdays.join(' and ')}.`, t.id, a.date);
      }
      if (a.date < season.startDate || a.date > season.endDate) {
        add('OUTSIDE_SEASON', 'error',
          `${t.name} has a game on ${a.date}, outside the season window.`, t.id, a.date);
      }
    }

    // games per scheduling week
    const perWeek = new Map<string, number>();
    for (const a of regular) {
      const k = weekKey(a.date, m.week.startsOn);
      perWeek.set(k, (perWeek.get(k) ?? 0) + 1);
    }
    for (const [k, n] of perWeek) {
      if (n > m.scheduling.maxGamesPerWeek) {
        add('OVER_WEEKLY_GAMES', 'warning',
          `${t.name} plays ${n} games in the week of ${k}; the target is ${m.scheduling.maxGamesPerWeek}.`,
          t.id, k);
      }
    }

    // counts against target
    if (regular.length !== gTarget) {
      add(regular.length > gTarget ? 'OVER_GAME_TARGET' : 'UNDER_GAME_TARGET',
        regular.length > gTarget ? 'error' : 'warning',
        `${t.name} has ${regular.length} regular-season games against a target of ${gTarget}.`, t.id);
    }
    if (m.capabilities.practices && pDates.length !== pTarget) {
      add(pDates.length > pTarget ? 'OVER_PRACTICE_TARGET' : 'UNDER_PRACTICE_TARGET', 'warning',
        `${t.name} has ${pDates.length} practices against a target of ${pTarget}.`, t.id);
    }

    // repeat-opponent clustering
    const opps = regular.map((a) => a.opponentId ?? '?');
    let run = 1, longest = 1;
    for (let i = 1; i < opps.length; i++) {
      run = opps[i] === opps[i - 1] ? run + 1 : 1;
      if (run > longest) longest = run;
    }
    if (longest >= 3) {
      add('REPEAT_OPPONENT_RUN', 'warning',
        `${t.name} plays the same opponent ${longest} times in a row.`, t.id);
    }

    reports.push({
      teamId: t.id, teamName: t.name, divisionId: t.divisionId,
      games: regular.length, gamesTarget: gTarget,
      awayGames: regular.filter((a) => a.away).length,
      practices: pDates.length, practicesTarget: pTarget, evaluations: eDates.length,
      bands, sameDayGameDates: sameDay.sort(), gameAndPracticeDates: both,
      longestRepeatRun: longest,
      opponents: opps.map((id) => teamById.get(id)?.name ?? id),
    });
  }

  // --- time band balance ----------------------------------------------------
  if (m.scheduling.balanceTimeBands) {
    for (const d of season.divisions) {
      const rs = reports.filter((r) => r.divisionId === d.id);
      for (const band of ['morning', 'midday', 'evening'] as TimeBand[]) {
        const vals = rs.map((r) => r.bands[band]);
        if (!vals.length) continue;
        const spread = Math.max(...vals) - Math.min(...vals);
        if (spread > 2) {
          add('TIME_BAND_IMBALANCE', 'warning',
            `${d.name}: ${band} games range from ${Math.min(...vals)} to ${Math.max(...vals)} across teams.`,
            d.id);
        }
      }
    }
  }

  // --- division integrity ---------------------------------------------------
  // Crossover is opt-in per division: two divisions meet only where one of
  // them names the other. Everything else is still an error, which is what
  // keeps 8U away from 15U without anyone having to remember.
  {
    for (const d of season.divisions) {
      for (const otherId of d.playsAcross) {
        const other = divById.get(otherId);
        if (!other) {
          add('CROSSOVER_UNKNOWN_DIVISION', 'error',
            `${d.name} is set to cross over with "${otherId}", which is not a division.`, d.id);
          continue;
        }
        if (other.iceFormat !== d.iceFormat) {
          add('CROSSOVER_FORMAT_MISMATCH', 'error',
            `${d.name} plays ${FORMAT_LABEL[d.iceFormat].toLowerCase()} and ${other.name} plays `
            + `${FORMAT_LABEL[other.iceFormat].toLowerCase()}, so they cannot meet: a sheet is `
            + 'set up one way at a time.', d.id);
        }
      }
      if (d.crossGamesPerTeam > 0 && crossoverPool(season.divisions, d.id).length < 2) {
        add('CROSSOVER_NO_PARTNER', 'warning',
          `${d.name} is set to play ${d.crossGamesPerTeam} crossover games but is not paired `
          + 'with another division.', d.id);
      }
      const target = d.gamesPerTeam ?? m.scheduling.defaultGamesPerTeam;
      if (d.crossGamesPerTeam > target) {
        add('CROSSOVER_OVER_TARGET', 'error',
          `${d.name} plays ${target} games but ${d.crossGamesPerTeam} of them are set to be `
          + 'crossover. Crossover games come out of the total, not on top of it.', d.id);
      }
    }

    for (const g of season.games) {
      if (!g.homeTeamId || !g.awayTeamId) continue;
      const h = teamById.get(g.homeTeamId), a = teamById.get(g.awayTeamId);
      if (!h || !a) continue;
      const hd = divById.get(h.divisionId), ad = divById.get(a.divisionId);
      const allowed = hd && ad
        ? (m.scheduling.interDivisionPlay || mayCross(hd, ad))
        : m.scheduling.interDivisionPlay;
      if (h.divisionId !== a.divisionId && !allowed) {
        add('CROSS_DIVISION_GAME', 'error',
          `${h.name} (${h.divisionId}) is scheduled against ${a.name} (${a.divisionId}), `
          + `but those divisions are not set to cross over.`, g.id);
      }
      if (g.divisionId !== h.divisionId) {
        add('GAME_DIVISION_MISMATCH', 'error',
          `Game ${g.id} is filed under ${g.divisionId} but ${h.name} is in ${h.divisionId}.`, g.id);
      }
    }
  }

  // --- household load -------------------------------------------------------
  // Households are matched WITHIN a league only. A family with a child in this
  // league and another elsewhere is not this validator's concern.
  if (m.capabilities.familyConstraints && season.people.length) {
    const teamOf = new Map<string, string>();
    for (const p of season.people) if (p.teamId && p.householdId) teamOf.set(p.id, p.teamId);

    const byHousehold = new Map<string, Set<string>>();
    for (const p of season.people) {
      if (!p.householdId || !p.teamId) continue;
      (byHousehold.get(p.householdId) ?? byHousehold.set(p.householdId, new Set()).get(p.householdId)!)
        .add(p.teamId);
    }

    const datesOfTeam = new Map<string, string[]>();
    for (const t of season.teams) {
      datesOfTeam.set(t.id, (gameApps.get(t.id) ?? []).map((a) => a.date));
    }
    for (const p of season.practices) {
      const slot = slotById.get(p.slotId);
      if (!slot) continue;
      for (const tid of p.teamIds) datesOfTeam.get(tid)?.push(slot.date);
    }

    for (const [hh, teamIds] of byHousehold) {
      if (teamIds.size < 2) continue;
      const perDate = new Map<string, Set<string>>();
      for (const tid of teamIds) {
        for (const d of datesOfTeam.get(tid) ?? []) {
          (perDate.get(d) ?? perDate.set(d, new Set()).get(d)!).add(tid);
        }
      }
      const names = season.people
        .filter((p) => p.householdId === hh)
        .map((p) => `${p.firstName} ${p.lastName}`).join(' and ');
      for (const [d, tids] of perDate) {
        if (tids.size > m.scheduling.maxHouseholdGamesPerDay) {
          add('HOUSEHOLD_OVERLOADED', 'warning',
            `${names || hh}: ${tids.size} separate sessions at the rink on ${d}, ` +
            `above the limit of ${m.scheduling.maxHouseholdGamesPerDay}.`, hh, d);
        }
      }
    }
  }

  // --- ice turnaround -------------------------------------------------------
  // Two bookings back to back on one sheet leave no time to clear the ice and
  // cut it. The booked ice already allows for this; hand-editing is what
  // breaks it, so the rule guards the edits rather than the import.
  {
    const byPlace = new Map<string, { s: number; e: number; label: string }[]>();
    const put = (date: string, rink: string, start: string, minutes: number, label: string) => {
      const k = `${date}|${rink}`;
      const st = minutesOf(start);
      (byPlace.get(k) ?? byPlace.set(k, []).get(k)!).push({ s: st, e: st + minutes, label });
    };
    // One entry per OCCUPIED SLOT, not per game. Two cross-ice games share a
    // single slot on purpose; whether that is allowed is the slot's capacity,
    // which SLOT_OVERBOOKED already covers.
    const occupied = new Set<string>();
    for (const g of season.games) if (g.slotId && !g.away) occupied.add(g.slotId);
    for (const p of season.practices) if (p.teamIds.length) occupied.add(p.slotId);
    for (const id of occupied) {
      const sl = slotById.get(id);
      if (sl) put(sl.date, sl.rink, sl.start, sl.minutes, sl.use);
    }
    for (const [k, list] of byPlace) {
      list.sort((a, b) => a.s - b.s);
      const [date, rink] = k.split('|') as [string, string];
      for (let i = 1; i < list.length; i++) {
        const gap = list[i]!.s - list[i - 1]!.e;
        const at = `${hhmm(list[i - 1]!.e)} to ${hhmm(list[i]!.s)}`;
        if (gap < 0) {
          add('ICE_DOUBLE_BOOKED', 'error',
            `${rink} on ${date}: two bookings overlap, ${at}.`, undefined, date);
        } else if (gap < MIN_TURNAROUND) {
          add('TURNAROUND_TOO_SHORT', 'warning',
            `${rink} on ${date}: only ${gap} minutes between bookings, ${at}. ` +
            `Allow at least ${MIN_TURNAROUND} to clear and cut the ice.`, undefined, date);
        }
      }
    }
  }

  // --- regular season finishes before playoffs ------------------------------
  if (m.scheduling.regularSeasonEndsBeforePlayoffs) {
    for (const d of season.divisions) {
      const dated = season.games.filter(
        (g) => g.divisionId === d.id && gameWhen(g, slotById));
      const dateOf = (g: Game) => gameWhen(g, slotById)!.date;
      const reg = dated.filter((g) => !PLAYOFF_TYPES.has(g.type)).map(dateOf);
      const po = dated.filter((g) => PLAYOFF_TYPES.has(g.type)).map(dateOf);
      if (reg.length && po.length) {
        const lastReg = reg.sort().at(-1)!;
        const firstPo = po.sort()[0]!;
        if (firstPo <= lastReg) {
          add('PLAYOFFS_OVERLAP_REGULAR', 'error',
            `${d.name}: playoffs start ${firstPo} but the regular season runs to ${lastReg}.`, d.id);
        }
      }
    }
  }

  // --- evaluations come first -----------------------------------------------
  {
    const evalSlots = season.slots.filter((s) => s.use === 'evaluation');

    // Zero sessions is the default, so nothing is said until a division asks
    // for evaluations by ticking the number up.
    for (const d of season.divisions) {
      if (d.evaluationSessions <= 0) continue;
      const booked = evalSlots.filter((s) => s.ownerDivisionId === d.id).length;
      if (!booked) {
        add('EVALUATION_ICE_MISSING', 'warning',
          `${d.name} needs ${d.evaluationSessions} evaluation session`
          + `${d.evaluationSessions === 1 ? '' : 's'} and has no evaluation ice. `
          + 'Repurpose a slot to Evaluation and give it to ' + `${d.name}.`, d.id);
      } else if (booked < d.evaluationSessions) {
        add('EVALUATION_ICE_SHORT', 'warning',
          `${d.name} needs ${d.evaluationSessions} evaluation sessions but only `
          + `${booked} sheet${booked === 1 ? ' is' : 's are'} marked for it.`, d.id);
      }
    }

    // The rule itself: nothing a division does may come before it is evaluated.
    const floors = playFloors(season);
    if (floors.size) {
      const seen = new Set<string>();
      for (const g of season.games) {
        const w = gameWhen(g, slotById);
        const floor = floors.get(g.divisionId);
        if (!w || !floor || w.date > floor) continue;
        const k = `g|${g.divisionId}|${w.date}`;
        if (seen.has(k)) continue;
        seen.add(k);
        add('PLAY_BEFORE_EVALUATION', 'error',
          `${divById.get(g.divisionId)?.name ?? g.divisionId} has a game on ${w.date}, `
          + `on or before its last evaluation on ${floor}. Evaluations come first.`,
          g.id, w.date);
      }
      for (const p of season.practices) {
        if (p.kind === 'evaluation') continue;
        const date = slotById.get(p.slotId)?.date;
        const floor = floors.get(p.divisionId);
        if (!date || !floor || date > floor) continue;
        const k = `p|${p.divisionId}|${date}`;
        if (seen.has(k)) continue;
        seen.add(k);
        add('PLAY_BEFORE_EVALUATION', 'error',
          `${divById.get(p.divisionId)?.name ?? p.divisionId} has a practice on ${date}, `
          + `on or before its last evaluation on ${floor}. Evaluations come first.`,
          p.id, date);
      }
    }
  }

  // --- brackets --------------------------------------------------------------
  {
    const bracket = season.games.filter((g) => PLAYOFF_TYPES.has(g.type));
    const byId = new Map(season.games.map((g) => [g.id, g]));

    if (bracket.length && !m.capabilities.playoffs) {
      add('PLAYOFFS_NOT_ALLOWED', 'error',
        `${m.name} does not run playoffs, but ${bracket.length} bracket games exist. `
        + 'Clear the bracket, or move this season to a league that has playoffs.');
    }

    for (const d of season.divisions) {
      const size = d.playoffTeams;
      const inDiv = bracket.filter((g) => g.divisionId === d.id);
      const teams = season.teams.filter((t) => t.divisionId === d.id).length;
      if (size > 0 && !isBracketSize(size)) {
        add('PLAYOFF_SIZE_UNSUPPORTED', 'error',
          `${d.name} qualifies ${size} teams. Supported bracket sizes are `
          + `${BRACKET_SIZES.join(', ')}.`, d.id);
      }
      if (size > teams) {
        add('PLAYOFF_SIZE_EXCEEDS_TEAMS', 'error',
          `${d.name} qualifies ${size} teams but only has ${teams}.`, d.id);
      }
      if (size > 0 && !inDiv.length) {
        add('PLAYOFF_BRACKET_MISSING', 'warning',
          `${d.name} qualifies ${size} teams but has no bracket yet. Build it on Playoffs.`, d.id);
      }
      if (inDiv.length && size === 0) {
        add('PLAYOFF_BRACKET_ORPHAN', 'warning',
          `${d.name} has ${inDiv.length} bracket games but qualifies nobody. `
          + 'Set the number of playoff teams, or clear the bracket.', d.id);
      }
    }

    for (const g of bracket) {
      const when = gameWhen(g, slotById);
      if (!when) {
        add('PLAYOFF_NO_ICE', 'error',
          `${roundName(g.type)} ${shortCode(g.id)} in ${divById.get(g.divisionId)?.name ?? g.divisionId} has no ice. `
          + 'Free up a slot after the regular season and build the bracket again.', g.id);
      }
      for (const src of [g.homeFrom, g.awayFrom]) {
        if (!src || src.kind === 'seed') continue;
        const feeder = src.gameId ? byId.get(src.gameId) : undefined;
        if (!feeder) {
          add('PLAYOFF_FEEDER_MISSING', 'error',
            `${roundName(g.type)} ${shortCode(g.id)} waits on game "${src.gameId}", `
            + 'which is not in this season.', g.id);
          continue;
        }
        const fw = gameWhen(feeder, slotById);
        if (!when || !fw) continue;
        if (fw.date + fw.start >= when.date + when.start) {
          add('PLAYOFF_ORDER', 'error',
            `${roundName(g.type)} ${shortCode(g.id)} is set for ${when.date} ${when.start}, `
            + `at or before ${shortCode(feeder.id)} on ${fw.date} ${fw.start}, which decides who `
            + 'plays in it.', g.id, when.date);
        }
      }
    }

    for (const d of season.divisions) {
      const inDiv = bracket.filter((g) => g.divisionId === d.id);
      if (!inDiv.length) continue;
      const pending = season.games.filter(
        (g) => g.divisionId === d.id && !PLAYOFF_TYPES.has(g.type)
          && g.homeGoals === null && g.awayGoals === null).length;
      if (pending) {
        add('PLAYOFF_SEEDS_PROVISIONAL', 'warning',
          `${d.name}: the bracket is seeded off the table as it stands, and ${pending} `
          + 'regular-season games still have no score. Seeds will move.', d.id);
      }
    }
  }

  // --- conservation ---------------------------------------------------------
  const placedRegular = season.games.filter(
    (g) => (g.slotId || g.away) && !PLAYOFF_TYPES.has(g.type) && g.homeTeamId && g.awayTeamId,
  ).length;
  const teamGames = reports.reduce((n, r) => n + r.games, 0);
  if (teamGames !== placedRegular * 2) {
    add('CONSERVATION_FAILED', 'error',
      `Team-game total ${teamGames} should be exactly twice the ${placedRegular} placed regular games.`);
  }

  // --- consecutive-day rule -------------------------------------------------
  if (m.scheduling.allowConsecutiveDays !== 'always') {
    const seasonLen = Math.max(1, daysBetween(season.startDate, season.endDate));
    for (const t of season.teams) {
      const ds = [...new Set((gameApps.get(t.id) ?? []).map((a) => a.date))].sort();
      for (let i = 1; i < ds.length; i++) {
        if (daysBetween(ds[i - 1]!, ds[i]!) !== 1) continue;
        const lateSeason = daysBetween(season.startDate, ds[i]!) / seasonLen > 0.75;
        if (m.scheduling.allowConsecutiveDays === 'never' || !lateSeason) {
          add('CONSECUTIVE_DAYS', 'warning',
            `${t.name} plays on ${ds[i - 1]} and ${ds[i]}, back-to-back days.`, t.id, ds[i]);
        }
      }
    }
  }

  const errorCount = v.filter((x) => x.severity === 'error').length;
  const warningCount = v.filter((x) => x.severity === 'warning').length;
  return { violations: v, teams: reports, ok: errorCount === 0, errorCount, warningCount };
}

/** Groups violations by code for a readable summary. */
export function summarize(r: ValidationResult): { code: string; severity: Severity; count: number }[] {
  const m = new Map<string, { code: string; severity: Severity; count: number }>();
  for (const x of r.violations) {
    const e = m.get(x.code) ?? { code: x.code, severity: x.severity, count: 0 };
    e.count++; m.set(x.code, e);
  }
  return [...m.values()].sort(
    (a, b) => (a.severity === b.severity ? b.count - a.count : a.severity === 'error' ? -1 : 1),
  );
}


/**
 * Two leagues sharing one building will happily book the same sheet of ice.
 * Each season validates alone, so nothing else catches it. Keyed on the
 * physical ice (date, start, rink) rather than slot id, because every season
 * mints its own slot ids from its own import.
 */
export interface IceConflict {
  date: string;
  rink: string;
  /** Earliest start and latest end across the overlapping bookings. */
  from: string;
  to: string;
  bookings: { seasonId: string; leagueId: string; start: string; end: string; kind: string }[];
}

/**
 * Two leagues sharing one building will happily book the same sheet of ice.
 * Each season validates alone, so nothing else catches it.
 *
 * Overlap is tested as INTERVALS, not equal start times. Real bookings are
 * staggered — 19:50, 20:00, 20:10, 20:30 — and an 80-minute slot starting at
 * 20:10 collides with a 60-minute slot starting at 20:30 even though the two
 * start times differ. Matching on a (date, start, rink) key would miss it.
 */
export function findIceConflicts(seasons: Season[]): IceConflict[] {
  type B = { seasonId: string; leagueId: string; start: string; end: string; kind: string;
             s: number; e: number };
  const byPlace = new Map<string, B[]>();

  for (const s of seasons) {
    const slotById = new Map(s.slots.map((x) => [x.id, x]));
    const used = new Map<string, string>();
    for (const g of s.games) if (g.slotId) used.set(g.slotId, 'game');
    for (const p of s.practices) if (p.teamIds.length) used.set(p.slotId, 'practice');

    for (const [slotId, kind] of used) {
      const slot = slotById.get(slotId);
      if (!slot) continue;
      const st = minutesOf(slot.start);
      const en = st + slot.minutes;
      const key = `${slot.date}|${slot.rink}`;
      const end = `${String(Math.floor(en / 60) % 24).padStart(2, '0')}:` +
        `${String(en % 60).padStart(2, '0')}`;
      (byPlace.get(key) ?? byPlace.set(key, []).get(key)!).push({
        seasonId: s.id, leagueId: s.leagueId, start: slot.start, end, kind, s: st, e: en,
      });
    }
  }

  const out: IceConflict[] = [];
  for (const [key, list] of byPlace) {
    list.sort((a, b) => a.s - b.s);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!, b = list[j]!;
        if (b.s >= a.e) break;                 // sorted, so nothing later overlaps either
        if (a.seasonId === b.seasonId) continue; // one season's own overbooking is its problem
        const [date, rink] = key.split('|') as [string, string];
        out.push({
          date, rink,
          from: a.s <= b.s ? a.start : b.start,
          to: a.e >= b.e ? a.end : b.end,
          bookings: [a, b].map(({ seasonId, leagueId, start, end, kind }) =>
            ({ seasonId, leagueId, start, end, kind })),
        });
      }
    }
  }
  return out.sort((a, b) => (a.date + a.from).localeCompare(b.date + b.from));
}
