import type { LeagueManifest } from './manifest.js';
import type { Season, Slot, SlotUse } from './schema.js';
import { PLAYOFF_TYPES } from './schema.js';
import { weekdayOf } from './time.js';

/**
 * Using a sheet of ice for something other than what it was booked as.
 *
 * This is not an edge case, it is how a rink hits its dates. The 8U game slot
 * at 7am Sunday is run as the evaluation skate because that is the hour
 * parents already look for, so the season opens where they expect it. The app
 * has to treat that as a decision worth keeping: visible, reversible,
 * protected from a rules pass, and handed back to whoever maintains the
 * booking system.
 *
 * Nothing here changes a season on its own. `suggestRepurpose` only proposes;
 * every change goes through `repurposeSlot`, which someone had to ask for.
 */

export const isRepurposed = (s: Slot): boolean =>
  s.bookedUse !== null && s.bookedUse !== s.use;

export const repurposedSlots = (season: Season): Slot[] =>
  season.slots.filter(isRepurposed);

/** Ice that has something on it cannot be quietly turned into something else. */
export function slotIsBusy(season: Season, slotId: string): boolean {
  if (season.games.some((g) => g.slotId === slotId)) return true;
  return season.practices.some((p) => p.slotId === slotId && p.teamIds.length > 0);
}

/**
 * Changes what a slot is for, remembering what it was booked as.
 *
 * The first repurpose is what records `bookedUse`; later ones keep the
 * original booking rather than overwriting it with the last thing we did, so
 * the comparison the rink needs stays true however many times we change our
 * minds.
 */
export function repurposeSlot(
  season: Season, slotId: string, use: SlotUse,
  opts: { note?: string; divisionId?: string | null } = {},
): Season {
  let hit = false;
  const slots = season.slots.map((s) => {
    if (s.id !== slotId) return s;
    hit = true;
    const bookedUse = s.bookedUse ?? s.use;
    const next: Slot = {
      ...s,
      use,
      bookedUse,
      repurposeNote: use === bookedUse ? '' : (opts.note ?? s.repurposeNote),
    };
    if (opts.divisionId !== undefined) next.ownerDivisionId = opts.divisionId;
    // Evaluation ice belongs to its division outright; nothing else may take it.
    if (use === 'evaluation' && next.ownerDivisionId) next.ownerPolicy = 'exclusive';
    return next;
  });
  return hit ? { ...season, slots } : season;
}

/** Puts a slot back to what the building booked it as. */
export function revertSlot(season: Season, slotId: string): Season {
  const slot = season.slots.find((s) => s.id === slotId);
  if (!slot || slot.bookedUse === null || slot.bookedUse === slot.use) return season;
  return {
    ...season,
    slots: season.slots.map((s) =>
      (s.id === slotId ? { ...s, use: s.bookedUse!, repurposeNote: '' } : s)),
  };
}

// ---------------------------------------------------------------------------

export interface RepurposeNeed {
  /** What the ice is needed for. */
  use: SlotUse;
  /** How many slots short we are. */
  count: number;
  /** Whose shortfall this is. Null means any division. */
  divisionId?: string | null;
  /** Only consider ice on or after this date. */
  from?: string;
  /** Only consider ice on or before this date. */
  until?: string;
  /** Only these weekdays, e.g. a division's practice night. */
  weekdays?: string[];
  /** What is short, in words, for the suggestion text. */
  reason?: string;
  /**
   * Consider ice that already has a game on it, when there is spare game ice
   * for that game to move to. Off by default, because a game is a commitment;
   * on when the ice itself is the point — an evaluation has to be in the hour
   * families expect, and that hour is usually booked as a game.
   */
  allowOccupied?: boolean;
}

export interface RepurposeSuggestion {
  slotId: string;
  date: string;
  start: string;
  rink: string;
  from: SlotUse;
  to: SlotUse;
  divisionId: string | null;
  /** Lower is safer to take. */
  cost: number;
  /** Why this slot is a reasonable one to take. */
  why: string;
}

/**
 * Names the specific slots that would fix a shortfall, cheapest first.
 *
 * Suggests only — the caller decides. Ice with a game on it is never
 * proposed; ice with nothing on it is proposed before ice that is merely
 * underused, and ice already reserved for the division that is short is
 * preferred over ice someone else is relying on.
 */
export function suggestRepurpose(
  season: Season, m: LeagueManifest, need: RepurposeNeed,
): RepurposeSuggestion[] {
  const busyGame = new Set(season.games.filter((g) => g.slotId).map((g) => g.slotId!));
  const practiceLoad = new Map<string, number>();
  for (const p of season.practices) {
    if (p.teamIds.length) practiceLoad.set(p.slotId, p.teamIds.length);
  }

  /**
   * How much game ice is going spare. A game sitting on a slot we want is
   * only movable if there is somewhere for it to go.
   */
  const spareGameSlots = season.slots.filter(
    (s) => s.use === 'game' && !busyGame.has(s.id)).length;
  let movable = need.allowOccupied ? spareGameSlots : 0;

  const out: RepurposeSuggestion[] = [];
  for (const s of season.slots) {
    if (s.use === need.use) continue;
    // A game is a commitment. It can be asked to move only when the caller
    // says the ice matters more and there is somewhere else for it to go.
    if (busyGame.has(s.id) && (!need.allowOccupied || movable <= 0)) continue;
    if (need.from && s.date < need.from) continue;
    if (need.until && s.date > need.until) continue;
    if (need.weekdays?.length && !need.weekdays.includes(weekdayOf(s.date))) continue;
    if (season.blackoutDates.includes(s.date)) continue;
    if (s.date < season.startDate || s.date > season.endDate) continue;
    const wd = weekdayOf(s.date);
    if (need.use === 'game') {
      if (m.scheduling.blockedWeekdays.includes(wd)) continue;
      if (m.scheduling.onlyWeekdays.length && !m.scheduling.onlyWeekdays.includes(wd)) continue;
    }
    // Ice another division holds outright is not ours to take.
    if (s.ownerDivisionId && s.ownerPolicy === 'exclusive'
      && need.divisionId && s.ownerDivisionId !== need.divisionId) continue;

    const teams = practiceLoad.get(s.id) ?? 0;
    let cost = 0;
    let why: string;
    if (busyGame.has(s.id)) {
      movable--;
      cost = 60;
      why = `a game is on it, and there ${spareGameSlots === 1 ? 'is' : 'are'} `
        + `${spareGameSlots} spare game slot${spareGameSlots === 1 ? '' : 's'} for it to move to`;
    } else if (s.use === 'unused') {
      why = 'out of play, so nothing is lost';
    } else if (teams === 0) {
      cost = 10;
      why = `${s.use} ice with nothing booked on it`;
    } else {
      cost = 100 + teams * 10;
      why = `${s.use} ice with ${teams} team${teams === 1 ? '' : 's'} on it — they would need another night`;
    }
    if (s.ownerDivisionId && need.divisionId && s.ownerDivisionId === need.divisionId) {
      cost -= 5;                                            // already theirs
      why += `, already held for ${s.ownerDivisionId}`;
    } else if (s.ownerDivisionId) {
      cost += 20;
      why += `, held for ${s.ownerDivisionId}`;
    }

    out.push({
      slotId: s.id, date: s.date, start: s.start, rink: s.rink,
      from: s.use, to: need.use, divisionId: need.divisionId ?? s.ownerDivisionId,
      cost, why,
    });
  }

  return out
    .sort((a, b) => a.cost - b.cost || (a.date + a.start).localeCompare(b.date + b.start))
    .slice(0, Math.max(0, need.count));
}

/** Applies a set of suggestions in one go. Still only when asked. */
export function applySuggestions(
  season: Season, picks: RepurposeSuggestion[], note: string,
): Season {
  let next = season;
  for (const p of picks) {
    next = repurposeSlot(next, p.slotId, p.to, { note, divisionId: p.divisionId });
  }
  return next;
}

/**
 * Where the booked ice and the schedule disagree, for the people who keep the
 * booking system. This is the list that goes back to the front desk.
 */
export interface IceDifference {
  date: string;
  day: string;
  start: string;
  minutes: number;
  rink: string;
  bookedAs: SlotUse;
  usedAs: SlotUse;
  division: string;
  onTheIce: string;
  note: string;
}

export function iceDifferences(season: Season): IceDifference[] {
  const teamName = new Map(season.teams.map((t) => [t.id, t.name]));
  const divName = new Map(season.divisions.map((d) => [d.id, d.name]));
  const bySlot = new Map<string, string[]>();
  for (const g of season.games) {
    if (!g.slotId) continue;
    const who = [g.homeTeamId, g.awayTeamId]
      .map((t) => (t ? teamName.get(t) ?? t : ''))
      .filter(Boolean).join(' v ');
    const label = PLAYOFF_TYPES.has(g.type) ? `${g.type}: ${who}` : who;
    (bySlot.get(g.slotId) ?? bySlot.set(g.slotId, []).get(g.slotId)!).push(label);
  }
  for (const p of season.practices) {
    const who = p.teamIds.map((t) => teamName.get(t) ?? t).join(', ');
    (bySlot.get(p.slotId) ?? bySlot.set(p.slotId, []).get(p.slotId)!)
      .push(`${p.kind}: ${who || 'nobody yet'}`);
  }

  return repurposedSlots(season)
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
    .map((s) => ({
      date: s.date,
      day: weekdayOf(s.date),
      start: s.start,
      minutes: s.minutes,
      rink: s.rink,
      bookedAs: s.bookedUse!,
      usedAs: s.use,
      division: s.ownerDivisionId ? divName.get(s.ownerDivisionId) ?? s.ownerDivisionId : '',
      onTheIce: (bySlot.get(s.id) ?? []).join('; '),
      note: s.repurposeNote,
    }));
}
