import type { IceRule, Season, Slot, SlotUse, Weekday } from './schema.js';
import { IceRule as IceRuleSchema } from './schema.js';
import { isRepurposed } from './repurpose.js';
import { weekdayOf } from './time.js';

/**
 * Standing rules about who gets which ice.
 *
 * A booked-ice export is 200 rows of date, time and rink, but a rink does not
 * think that way. It thinks "Wednesday at 6:10 is 8U practice" and "7am Sunday
 * is 8U games until they have their games, then it is open". Six or seven
 * rules like that describe a whole season, so they are held as rules and
 * stamped onto the slots, rather than hand-edited row by row where nobody can
 * see whether they were applied correctly.
 */


export function ruleMatches(rule: IceRule, slot: Slot): boolean {
  if (rule.weekdays.length && !rule.weekdays.includes(weekdayOf(slot.date))) return false;
  if (rule.start && rule.start !== slot.start) return false;
  if (rule.rink && rule.rink !== slot.rink) return false;
  if (rule.matchUse && rule.matchUse !== slot.use) return false;
  return true;
}

export interface RuleApplication { ruleId: string; matched: number }

/**
 * Stamps the rules onto the slots. Later rules win, so the list reads top to
 * bottom like a policy: a broad rule first, then the exceptions.
 *
 * Pure, and returns the same season when nothing changed.
 */
export function applyIceRules(
  season: Season, rules: IceRule[] = season.iceRules,
  opts: { respectRepurposed?: boolean } = {},
): { season: Season; applied: RuleApplication[]; skipped: number } {
  const applied: RuleApplication[] = rules.map((r) => ({ ruleId: r.id, matched: 0 }));
  const respect = opts.respectRepurposed ?? true;
  let changed = false;
  let skipped = 0;

  const slots = season.slots.map((slot) => {
    // A slot somebody deliberately turned into something else is a decision,
    // not a gap in the rules. A standing rule must not quietly undo it.
    if (respect && isRepurposed(slot)) { skipped++; return slot; }
    let next = slot;
    rules.forEach((rule, i) => {
      if (!ruleMatches(rule, slot)) return;
      applied[i]!.matched++;
      const use = rule.setUse ?? next.use;
      const teams = rule.practiceTeams || next.practiceTeams;
      const capacity = rule.capacity || next.capacity;
      if (use !== next.use || rule.divisionId !== next.ownerDivisionId
        || rule.policy !== next.ownerPolicy || teams !== next.practiceTeams
        || capacity !== next.capacity) {
        next = {
          ...next, use, ownerDivisionId: rule.divisionId,
          ownerPolicy: rule.policy, practiceTeams: teams, capacity,
        };
      }
    });
    if (next !== slot) changed = true;
    return next;
  });

  return { season: changed ? { ...season, slots } : season, applied, skipped };
}

/**
 * Reads the booked ice and proposes the rules it looks like.
 *
 * A rink books the same weekday and start time every week, so a weekday+time
 * pattern that repeats is almost always one group's standing ice. This gets
 * the table started; the division on each row is the part only Tom knows, and
 * an imported Event Type fills it in where it said so.
 */
export function suggestIceRules(season: Season, minRepeats = 3): IceRule[] {
  const groups = new Map<string, Slot[]>();
  for (const s of season.slots) {
    if (s.use === 'unused') continue;
    const key = `${weekdayOf(s.date)}|${s.start}|${s.use}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
  }

  const out: IceRule[] = [];
  for (const [key, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    if (list.length < minRepeats) continue;
    const [weekday, start, use] = key.split('|') as [Weekday, string, SlotUse];
    // If every slot in the pattern already names the same division, keep it.
    const owners = new Set(list.map((s) => s.ownerDivisionId ?? ''));
    const owner = owners.size === 1 ? [...owners][0]! : '';
    out.push(IceRuleSchema.parse({
      id: `rule-${weekday}-${start.replace(':', '')}-${use}`,
      weekdays: [weekday], start, rink: '', matchUse: use, setUse: use,
      divisionId: owner || null,
      policy: use === 'evaluation' ? 'exclusive' : 'priority',
      capacity: 0, practiceTeams: 0,
      note: `${list.length} slots`,
    }));
  }
  return out.sort((a, b) =>
    (a.weekdays[0] ?? '').localeCompare(b.weekdays[0] ?? '') || (a.start ?? '').localeCompare(b.start ?? ''));
}

/** One line of English for a rule, for the table and the checks. */
export function describeRule(rule: IceRule, divisionName = (id: string) => id): string {
  const when = rule.weekdays.length
    ? rule.weekdays.map((d) => d[0]!.toUpperCase() + d.slice(1)).join(', ') : 'Any day';
  const at = rule.start ? ` at ${rule.start}` : '';
  const where = rule.rink ? ` on ${rule.rink}` : '';
  const what = rule.setUse ? ` is ${rule.setUse} ice` : '';
  const cross = rule.capacity > 1 ? `, ${rule.capacity} at once` : '';
  if (!rule.divisionId) return `${when}${at}${where}${what}${cross}, open to everyone.`;
  const who = divisionName(rule.divisionId);
  const how = rule.policy === 'exclusive'
    ? `${who} only, never released`
    : `${who} first, released once ${who} has what it needs`;
  return `${when}${at}${where}${what}${cross}: ${how}.`;
}
