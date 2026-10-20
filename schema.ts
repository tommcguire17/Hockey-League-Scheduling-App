import { z } from 'zod';

/**
 * The canonical data model. Every importer parses INTO these shapes and every
 * exporter reads OUT of them, so a change in any source format is absorbed in
 * one importer rather than rippling through the app.
 *
 * Parse, don't validate: nothing downstream accepts an unparsed object.
 */

export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM (24h)');
export const Id = z.string().min(1);

export const Weekday = z.enum([
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
]);
export type Weekday = z.infer<typeof Weekday>;

/**
 * What a piece of ice is for.
 *
 * Evaluations are their own category rather than a flavour of practice: they
 * are run by the club, the whole division is on the ice at once, and they
 * must never receive a game.
 *
 * Playoff ice is its own category for the opposite reason — it is a game
 * sheet, but one the regular season may not have. Marking the last weekends
 * as playoff ice is how a rink says "the season ends here", and it is a
 * stronger statement than anything the generator can work out for itself:
 * the brackets get that ice, the regular season is squeezed into what is
 * left, and the doubling-up needed to make that fit follows from the
 * decision instead of being argued about separately.
 */
export const SlotUse = z.enum(['game', 'practice', 'evaluation', 'playoff', 'unused']);
export type SlotUse = z.infer<typeof SlotUse>;

/** Ice a game can be played on, bracket or otherwise. */
export const GAME_USES: ReadonlySet<SlotUse> = new Set<SlotUse>(['game', 'playoff']);

export const USE_LABEL: Record<SlotUse, string> = {
  game: 'Game',
  practice: 'Practice',
  evaluation: 'Evaluation',
  playoff: 'Playoff',
  unused: 'Out of play',
};

/**
 * What a division's claim on a slot means.
 *
 * `priority` is the usual case and the one a rink actually runs: 7am Sunday is
 * 8U's until 8U has all its games, and then anyone may have it. `exclusive`
 * never releases, which is right for an evaluation sheet and almost nothing
 * else — held ice that nobody can use is ice sold to no one.
 */
export const OwnerPolicy = z.enum(['priority', 'exclusive']);
export type OwnerPolicy = z.infer<typeof OwnerPolicy>;

export const GameType = z.enum([
  'regular', 'quarterfinal', 'semifinal', 'final', 'consolation', 'exhibition',
]);
export type GameType = z.infer<typeof GameType>;

/**
 * The one definition of "this is a playoff game". Three copies of this set
 * used to live in three files, which is three chances for them to disagree
 * the next time a round is added.
 */
export const PLAYOFF_TYPES: ReadonlySet<GameType> = new Set<GameType>([
  'quarterfinal', 'semifinal', 'final', 'consolation',
]);
export const isPlayoffType = (t: GameType): boolean => PLAYOFF_TYPES.has(t);

/**
 * How a division splits a sheet. Full ice is one game; half ice is two played
 * across the width; cross-ice is three in the zones. It is a property of the
 * age group, not of the booking — every team in a division plays the same
 * way — so it is set once on the division and the slots follow.
 */
export const IceFormat = z.enum(['full', 'half', 'cross']);
export type IceFormat = z.infer<typeof IceFormat>;

/** Games that fit on one sheet at once, by format. */
export const GAMES_PER_SHEET: Record<IceFormat, number> = { full: 1, half: 2, cross: 3 };

export const FORMAT_LABEL: Record<IceFormat, string> = {
  full: 'Full ice', half: 'Half ice', cross: 'Cross ice',
};

/** A booked piece of ice. The atom everything else competes for. */
export const Slot = z.object({
  id: Id,
  date: IsoDate,
  start: ClockTime,
  /** Minutes of ice, including flood if the booking includes it. */
  minutes: z.number().int().positive(),
  rink: z.string().min(1),
  /** What this ice is actually being used for. */
  use: SlotUse.default('game'),
  /**
   * What the building booked it as, which is not always what we do with it.
   *
   * An 8U game sheet at 7am Sunday run as the evaluation skate is a deliberate
   * decision — parents expect that slot, so the season opens where they already
   * look for it. Keeping both answers is what lets the app protect that choice
   * from a rules pass or a fresh Finnly export, and hand the rink a list of
   * where the two disagree. Null means nobody ever recorded a booked use.
   */
  bookedUse: SlotUse.nullable().default(null),
  /** Why the ice is being used for something else. */
  repurposeNote: z.string().default(''),
  /**
   * Games on this sheet at once. 0 means work it out from the format of
   * whichever division is playing on it, which is the usual case: a booking
   * does not know whether it is holding one full-ice game or three cross-ice
   * ones until you know who is on it. Set a number only to override.
   */
  capacity: z.number().int().min(0).max(4).default(0),
  /**
   * How many teams share this slot when used for practice.
   * 0 means work it out: however many the owning division needs that week,
   * which is what a rink actually does — one sheet, the whole age group on it.
   */
  practiceTeams: z.number().int().min(0).max(6).default(0),
  /** The division with a claim on this slot. See OwnerPolicy for how strong. */
  ownerDivisionId: Id.nullable().default(null),
  ownerPolicy: OwnerPolicy.default('priority'),
  /** Free-text provenance, e.g. "EVALS" or the Finnly event type. */
  tag: z.string().default(''),
});
export type Slot = z.infer<typeof Slot>;

export const Team = z.object({
  id: Id,
  divisionId: Id,
  name: z.string().min(1),
  coach: z.string().default(''),
  /** Dates this team cannot play at all. */
  blackoutDates: z.array(IsoDate).default([]),
  /** When non-empty, the ONLY weekdays this team may play. */
  allowedWeekdays: z.array(Weekday).default([]),
});
export type Team = z.infer<typeof Team>;

export const Division = z.object({
  id: Id,
  name: z.string().min(1),
  /** Overrides of the league manifest for this division only. */
  gamesPerTeam: z.number().int().min(0).nullable().default(null),
  practicesPerTeam: z.number().int().min(0).nullable().default(null),
  /**
   * Evaluation skates this division needs before it plays. Zero is the
   * default, so no league acquires evaluations by accident; tick it up to
   * however many sheets the level needs, which is more than one when signups
   * are heavy.
   */
  evaluationSessions: z.number().int().min(0).max(6).default(0),
  /**
   * How this division splits a sheet. Every team in a division plays the same
   * way, so one setting here replaces a capacity on every slot they use.
   */
  iceFormat: IceFormat.default('full'),
  /**
   * Divisions this one may also play. Empty, the usual case, means play stays
   * inside the division.
   *
   * For four D-level adult divisions of similar standard, crossing over keeps
   * the fixture list from going stale without merging the tables. Read both
   * ways round: if either division names the other, the pair may meet.
   */
  playsAcross: z.array(Id).default([]),
  /**
   * How many of this division's games are against a crossover division.
   * Comes OUT of gamesPerTeam rather than on top of it, so the season length
   * does not change.
   */
  crossGamesPerTeam: z.number().int().min(0).default(0),
  playoffTeams: z.number().int().min(0).default(0),
});
export type Division = z.infer<typeof Division>;

/**
 * A game played somewhere other than our building. It consumes none of our
 * ice, but the team is still committed: it counts toward their game total and
 * blocks them from playing here the same day or week.
 */
export const AwayVenue = z.object({
  facility: z.string().min(1),
  city: z.string().default(''),
  date: IsoDate,
  start: ClockTime,
  minutes: z.number().int().positive().default(60),
});
export type AwayVenue = z.infer<typeof AwayVenue>;

/**
 * Where a bracket game's team comes from, before it is known.
 *
 * A bracket is held in the games themselves rather than in a parallel
 * structure: each playoff game says what feeds it, and the resolver walks
 * those links. That way a season file read on its own is still a complete,
 * legible bracket, and there is nothing to keep in step.
 */
export const SeedSource = z.object({
  kind: z.enum(['seed', 'winner', 'loser']),
  /** Division rank for kind 'seed', 1-based: 1 is first place. */
  rank: z.number().int().min(1).nullable().default(null),
  /** The game whose result decides this, for 'winner' and 'loser'. */
  gameId: Id.nullable().default(null),
});
export type SeedSource = z.infer<typeof SeedSource>;

export const Game = z.object({
  id: Id,
  divisionId: Id,
  /** Null means the fixture exists but has no ice yet. */
  slotId: Id.nullable().default(null),
  homeTeamId: Id.nullable(),
  awayTeamId: Id.nullable(),
  /** Bracket placeholder shown before seeds resolve, e.g. "Seed 1". */
  homeLabel: z.string().default(''),
  awayLabel: z.string().default(''),
  /** Set on bracket games. Null on everything else. */
  homeFrom: SeedSource.nullable().default(null),
  awayFrom: SeedSource.nullable().default(null),
  type: GameType.default('regular'),
  homeGoals: z.number().int().min(0).nullable().default(null),
  awayGoals: z.number().int().min(0).nullable().default(null),
  /** Set when the game is played at another rink. Mutually exclusive with slotId. */
  away: AwayVenue.nullable().default(null),
  /** The generator never moves a locked game. Use it to pin a fixture by hand. */
  locked: z.boolean().default(false),
});
export type Game = z.infer<typeof Game>;

/** Evaluation skates occupy practice ice but do not count toward a team's
 *  practice target, which is how the source workbook treats them. */
export const PracticeKind = z.enum(['practice', 'evaluation']);
export type PracticeKind = z.infer<typeof PracticeKind>;

export const Practice = z.object({
  id: Id,
  divisionId: Id,
  slotId: Id,
  teamIds: z.array(Id).default([]),
  kind: PracticeKind.default('practice'),
});
export type Practice = z.infer<typeof Practice>;

/**
 * People are modelled but NEVER written to the repository. householdId is what
 * finally lets the scheduler reason about families rather than teams.
 */
export const Person = z.object({
  id: Id,
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  divisionId: Id.nullable().default(null),
  teamId: Id.nullable().default(null),
  birthDate: IsoDate.nullable().default(null),
  householdId: Id.nullable().default(null),
  guardianName: z.string().default(''),
  guardianEmail: z.string().default(''),
  jerseyNumber: z.number().int().min(0).max(99).nullable().default(null),
  jerseySize: z.string().default(''),
  sockSize: z.string().default(''),
  numberPrefs: z.array(z.number().int().min(0).max(99)).default([]),
  registeredAt: z.string().default(''),
});
export type Person = z.infer<typeof Person>;

/** Where a game sat, in words, at a point in time. */
export const Placement = z.object({
  date: IsoDate.nullable().default(null),
  start: ClockTime.nullable().default(null),
  rink: z.string().default(''),
  away: z.boolean().default(false),
});
export type Placement = z.infer<typeof Placement>;

export const ChangeReason = z.enum([
  'weather', 'ice-failure', 'team-request', 'referee', 'rink-conflict',
  'tournament', 'illness', 'balance', 'other',
]);
export type ChangeReason = z.infer<typeof ChangeReason>;

/**
 * A move, kept rather than overwritten. When a parent asks why a game changed,
 * this is the answer: what it was, what it became, when it was decided and why.
 */
export const ScheduleChange = z.object({
  id: Id,
  gameId: Id,
  /** When the change was recorded, as an ISO timestamp. */
  at: z.string().min(1),
  from: Placement,
  to: Placement,
  reason: ChangeReason.default('other'),
  note: z.string().default(''),
  /** Set once families have been told. */
  announced: z.boolean().default(false),
});
export type ScheduleChange = z.infer<typeof ScheduleChange>;

/**
 * A standing rule about who gets which ice: "Wednesday at 18:10 is 8U
 * practice", "7am Sunday is 8U games first". The shape lives here with the
 * rest of the model; applying and suggesting them is iceRules.ts.
 */
export const IceRule = z.object({
  id: Id,
  /** Days this rule covers. Empty means every day. */
  weekdays: z.array(Weekday).default([]),
  /** Exact start time, as it appears on the slot. Null means any time. */
  start: ClockTime.nullable().default(null),
  /** Limit to one rink. Empty means any rink. */
  rink: z.string().default(''),
  /** Only touch slots already set to this use. Null means any use. */
  matchUse: SlotUse.nullable().default(null),
  /** Set the slot to this use. Null leaves the use alone. */
  setUse: SlotUse.nullable().default(null),
  /** The division that gets the slot. Null clears any claim. */
  divisionId: Id.nullable().default(null),
  policy: OwnerPolicy.default('priority'),
  /** Games the slot runs at once. 2 is cross-ice. 0 leaves it alone. */
  capacity: z.number().int().min(0).max(4).default(0),
  /** Teams sharing a practice slot. 0 leaves it on auto. */
  practiceTeams: z.number().int().min(0).max(6).default(0),
  note: z.string().default(''),
});
export type IceRule = z.infer<typeof IceRule>;

export const Season = z.object({
  schemaVersion: z.literal(1).default(1),
  id: Id,
  name: z.string().min(1),
  leagueId: z.string().min(1),
  startDate: IsoDate,
  endDate: IsoDate,
  venue: z.string().default(''),
  city: z.string().default(''),
  /**
   * League-wide dates with no play: school breaks, exam weeks, holidays.
   * Per-team blackouts live on Team.blackoutDates. Both are honoured by the
   * generator and reported by the validator.
   */
  blackoutDates: z.array(IsoDate).default([]),
  divisions: z.array(Division).default([]),
  teams: z.array(Team).default([]),
  slots: z.array(Slot).default([]),
  games: z.array(Game).default([]),
  practices: z.array(Practice).default([]),
  /** Optional and PII-bearing. Omitted from anything that leaves the machine. */
  people: z.array(Person).default([]),
  /** Every move since the schedule was published, newest last. */
  changes: z.array(ScheduleChange).default([]),
  /**
   * Standing rules about who gets which ice, applied to the slots. Held as
   * rules so they can be read and corrected in one place. See iceRules.ts.
   */
  iceRules: z.array(IceRule).default([]),
  /**
   * Do the beaten semifinalists play for third?
   *
   * A season-level decision, not a per-build one, because two parts of the
   * app need the same answer and must not guess separately: the Playoffs tab
   * builds the bracket from it, and the generator sizes the ice it holds back
   * from it. Guessing cost a whole extra night of ice for a game the league
   * does not play. Off by default, which is what the house league does.
   */
  playoffConsolation: z.boolean().default(false),
});
export type Season = z.infer<typeof Season>;

/**
 * How many games of this division fit on this sheet at once.
 *
 * An explicit capacity on the slot wins, for the booking that is an exception;
 * otherwise the division's format decides, which is the usual case. A sheet
 * does not know whether it is holding one full-ice game or three cross-ice
 * ones until you know who is on it.
 */
/** May these two divisions meet? Read both ways, so a half-set pair still works. */
export function mayCross(a: Division, b: Division): boolean {
  if (a.id === b.id) return true;
  return a.playsAcross.includes(b.id) || b.playsAcross.includes(a.id);
}

/**
 * Divisions reachable from this one by crossover, itself included.
 * Crossover is treated as transitive: if A plays B and B plays C, the three
 * of them are one pool, which is what "four D divisions" means in practice.
 */
export function crossoverPool(divisions: readonly Division[], id: string): Division[] {
  const byId = new Map(divisions.map((d) => [d.id, d]));
  const seen = new Set<string>([id]);
  const queue = [id];
  while (queue.length) {
    const cur = byId.get(queue.shift()!);
    if (!cur) continue;
    for (const d of divisions) {
      if (seen.has(d.id) || !mayCross(cur, d)) continue;
      seen.add(d.id);
      queue.push(d.id);
    }
  }
  return divisions.filter((d) => seen.has(d.id));
}

export function slotHolds(slot: Slot, division?: { iceFormat: IceFormat }): number {
  if (slot.capacity > 0) return slot.capacity;
  return division ? GAMES_PER_SHEET[division.iceFormat] : 1;
}

/**
 * Where and when a game actually happens, whether that is our ice or someone
 * else's. Returns null for a fixture that has no date yet.
 *
 * Everything that asks "is this team busy?" goes through here, so away games
 * are never accidentally treated as free time.
 */
export function gameWhen(
  g: Game, slotById: ReadonlyMap<string, Slot>,
): { date: string; start: string; minutes: number; rink: string; away: boolean } | null {
  if (g.away) {
    return {
      date: g.away.date, start: g.away.start, minutes: g.away.minutes,
      rink: g.away.facility, away: true,
    };
  }
  if (!g.slotId) return null;
  const s = slotById.get(g.slotId);
  if (!s) return null;
  return { date: s.date, start: s.start, minutes: s.minutes, rink: s.rink, away: false };
}

/** Reads a game's current placement, for recording a change against it. */
export function placementOf(g: Game, slotById: ReadonlyMap<string, Slot>): Placement {
  const w = gameWhen(g, slotById);
  if (!w) return { date: null, start: null, rink: '', away: false };
  return { date: w.date, start: w.start, rink: w.rink, away: w.away };
}

export function samePlacement(a: Placement, b: Placement): boolean {
  return a.date === b.date && a.start === b.start && a.rink === b.rink && a.away === b.away;
}

export const REASON_LABELS: Record<ChangeReason, string> = {
  weather: 'Weather',
  'ice-failure': 'Ice or plant failure',
  'team-request': 'Team request',
  referee: 'No officials',
  'rink-conflict': 'Rink conflict',
  tournament: 'Tournament',
  illness: 'Illness or short bench',
  balance: 'Schedule balance',
  other: 'Other',
};

/** Strips every person field before a season is shared or exported. */
export function withoutPeople(season: Season): Season {
  return { ...season, people: [] };
}
