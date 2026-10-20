import type { Season, Slot } from './schema.js';

/**
 * Evaluations come first. Always.
 *
 * A division is evaluated before it plays or practises — that is the whole
 * point of an evaluation, and a schedule that puts a game before one is not
 * slightly wrong, it is unusable. So the date of a division's last evaluation
 * is a floor under everything else that division does, and it is computed
 * here once rather than being re-derived by the generator, the practice
 * assigner and the validator in three slightly different ways.
 *
 * A level with heavy signups runs more than one session, which is why this
 * is the LAST evaluation and not the first.
 */

/**
 * The earliest date each division may play or practise: the day after its own
 * last evaluation. Divisions without evaluation ice are absent from the map
 * and are unconstrained.
 */
export function playFloors(season: Season): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of season.slots) {
    if (s.use !== 'evaluation' || !s.ownerDivisionId) continue;
    const cur = out.get(s.ownerDivisionId);
    if (!cur || s.date > cur) out.set(s.ownerDivisionId, s.date);
  }
  // Also honour evaluations already booked on ice that has since been
  // relabelled, so moving a slot does not quietly drop the floor.
  const slotById = new Map(season.slots.map((s) => [s.id, s]));
  for (const p of season.practices) {
    if (p.kind !== 'evaluation') continue;
    const date = slotById.get(p.slotId)?.date;
    if (!date) continue;
    const cur = out.get(p.divisionId);
    if (!cur || date > cur) out.set(p.divisionId, date);
  }
  return out;
}

/** Can this division play on this date, given its evaluations? */
export function playableOn(
  floors: ReadonlyMap<string, string>, divisionId: string, date: string,
): boolean {
  const floor = floors.get(divisionId);
  return !floor || date > floor;
}

export interface EvaluationStatus {
  divisionId: string;
  divisionName: string;
  /** Sessions this division needs. Zero means it does not run them. */
  wanted: number;
  /** Evaluation slots actually booked for it. */
  booked: number;
  dates: string[];
  /** The day after the last one. Everything else starts here. */
  playsFrom: string | null;
  /** Everything a division needs before it can open. Met or not met. */
  fulfilled: boolean;
  /** What is stopping it, in words. Empty when fulfilled. */
  blockers: string[];
}

/**
 * Is this division evaluated and ready to open?
 *
 * Met or not met, not a tally to read and interpret. A division needs the
 * sessions it says it needs, and everything it does must come after them.
 * Zero sessions is the default and means the division does not run
 * evaluations at all, which is how a league that has never held one stays
 * quiet without a separate flag to turn off.
 */
export function evaluationStatus(season: Season): EvaluationStatus[] {
  const floors = playFloors(season);
  const slotById = new Map(season.slots.map((s) => [s.id, s]));

  const firstPlay = new Map<string, string>();
  const note = (div: string, date?: string) => {
    if (!date) return;
    const cur = firstPlay.get(div);
    if (!cur || date < cur) firstPlay.set(div, date);
  };
  for (const g of season.games) {
    note(g.divisionId, g.slotId ? slotById.get(g.slotId)?.date : g.away?.date);
  }
  for (const p of season.practices) {
    if (p.kind === 'evaluation') continue;
    note(p.divisionId, slotById.get(p.slotId)?.date);
  }

  return season.divisions.map((d) => {
    const dates = season.slots
      .filter((s) => s.use === 'evaluation' && s.ownerDivisionId === d.id)
      .map((s) => s.date).sort();
    const floor = floors.get(d.id);
    const opens = firstPlay.get(d.id);
    const blockers: string[] = [];

    const want = d.evaluationSessions;
    if (want > 0 && !dates.length) {
      blockers.push('no evaluation ice');
    } else if (want > 0 && dates.length < want) {
      blockers.push(`${dates.length} of ${want} sessions booked`);
    }
    // Whenever there IS evaluation ice, nothing may come before it — even for
    // a division that never asked for any.
    if (floor && opens && opens <= floor) {
      blockers.push(`plays on ${opens}, before its last evaluation on ${floor}`);
    }

    return {
      divisionId: d.id,
      divisionName: d.name,
      wanted: want,
      booked: dates.length,
      dates,
      playsFrom: floor ? nextDay(floor) : null,
      fulfilled: blockers.length === 0,
      blockers,
    };
  });
}

/**
 * How ready the league is, as one number: 100% when every division that runs
 * evaluations has them booked and nothing scheduled before them.
 *
 * Divisions that run none are left out of the count rather than padding it
 * with free passes, so the percentage means something.
 */
export function evaluationReadiness(
  season: Season,
): { ready: number; total: number; percent: number; fulfilled: boolean } {
  const all = evaluationStatus(season)
    .filter((x) => x.wanted > 0 || x.dates.length > 0);
  const ready = all.filter((x) => x.fulfilled).length;
  const total = all.length;
  return {
    ready,
    total,
    percent: total ? Math.round((ready / total) * 100) : 100,
    fulfilled: ready === total,
  };
}

/**
 * Marks the ice an evaluation is actually on.
 *
 * A season built before evaluations were their own slot use — the workbook
 * import, say — carries the session as a practice of kind 'evaluation' while
 * the slot still says 'practice' or 'game'. The session is the truth about
 * what happens on that ice, so this brings the slot into line and records
 * what it was booked as, which is exactly the repurpose it always was: the
 * 8U skate on the 7am Sunday game sheet.
 *
 * Pure, and returns the same season when there is nothing to reconcile.
 */
export function markEvaluationIce(season: Season): Season {
  const want = new Map<string, string>();        // slotId -> divisionId
  for (const p of season.practices) {
    if (p.kind === 'evaluation') want.set(p.slotId, p.divisionId);
  }
  if (!want.size) return season;

  let changed = false;
  const slots = season.slots.map((s): Slot => {
    const div = want.get(s.id);
    if (div === undefined || s.use === 'evaluation') return s;
    changed = true;
    return {
      ...s,
      use: 'evaluation',
      bookedUse: s.bookedUse ?? s.use,
      ownerDivisionId: s.ownerDivisionId ?? div,
      ownerPolicy: 'exclusive',
      // A sharing cap is a practice idea; an evaluation is the whole group.
      practiceTeams: 0,
      repurposeNote: s.repurposeNote
        || `Run as the ${div} evaluation skate rather than the ${s.use} it was booked as.`,
    };
  });
  // An older season never had the setting, so take it from the ice it ran.
  const ran = new Map<string, number>();
  for (const div of want.values()) ran.set(div, (ran.get(div) ?? 0) + 1);
  let divisionsChanged = false;
  const divisions = season.divisions.map((d) => {
    const n = ran.get(d.id) ?? 0;
    if (n <= d.evaluationSessions) return d;
    divisionsChanged = true;
    return { ...d, evaluationSessions: n };
  });

  if (!changed && !divisionsChanged) return season;
  return { ...season, slots, divisions };
}

function nextDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
