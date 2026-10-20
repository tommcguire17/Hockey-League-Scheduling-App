import { z } from 'zod';
import { Weekday, ClockTime } from './schema.js';

/**
 * A league manifest is the ONLY place a league's rules are expressed.
 * There is no `if (league === 'adult')` anywhere in this codebase; adding a
 * fourth league means adding a manifest, not editing the engine.
 */

export const GamesOnPracticeIce = z.enum(['never', 'lastResort', 'allowed']);
export const ConsecutiveDays = z.enum(['never', 'lateSeason', 'always']);

export const LeagueManifest = z.object({
  id: z.string().min(1),
  name: z.string().min(1),

  capabilities: z.object({
    practices: z.boolean(),
    playoffs: z.boolean(),
    standings: z.boolean(),
    /** Two games on one sheet at once. */
    crossIce: z.boolean(),
    scores: z.boolean(),
    /**
     * Honour household links when scheduling, so siblings in different
     * divisions are not dragged to the rink twice in a day. Scoped WITHIN a
     * league; households are never matched across leagues.
     */
    familyConstraints: z.boolean().default(false),
  }),

  week: z.object({
    /** Which day a scheduling week starts on. Decides "one game per week". */
    startsOn: Weekday,
  }),

  scheduling: z.object({
    defaultGamesPerTeam: z.number().int().min(0),
    defaultPracticesPerTeam: z.number().int().min(0),
    /** Hard ceiling. A team never plays more than this in a week. */
    maxGamesPerWeek: z.number().int().min(1),
    /**
     * Games in a week before it starts costing. Anything between this and
     * maxGamesPerWeek is allowed but penalised, and the penalty fades as the
     * season goes on, because a second game in February is catching up and a
     * second game in December is just crowding.
     *
     * Equal to maxGamesPerWeek means the old behaviour: a hard limit.
     */
    softGamesPerWeek: z.number().int().min(1).default(1),
    maxPracticesPerWeek: z.number().int().min(0),
    /**
     * May a team play twice on one day at all? The gate; `sameDayRest` then
     * says which same-day pairs are acceptable.
     */
    allowSameDayDoubleheader: z.boolean(),
    /**
     * How long a team may wait between two games on the same day, measured
     * from the end of the first to the start of the second.
     *
     * A weekend double is an exception the rink makes deliberately, to get a
     * season into the ice it has. The exception is only worth making if the
     * day is bearable for the family, and "bearable" is a span, not a yes:
     *
     *  - Too little, and they come off the ice and go straight back on. No
     *    time to rest, eat, or dry out between games.
     *  - Too much, and there is nothing to do but sit in the rink for hours,
     *    or drive home and drive back. Two or three slots between games is
     *    already past that line.
     *
     * Outside the span, the second game belongs on the other day of the
     * weekend instead, which is the arrangement everyone prefers anyway.
     * Ignored entirely when allowSameDayDoubleheader is false.
     */
    sameDayRest: z.object({
      minMinutes: z.number().int().min(0).default(45),
      maxMinutes: z.number().int().min(0).default(150),
    }).default({ minMinutes: 45, maxMinutes: 150 }),
    /**
     * How much more a same-day double costs than the same two games split
     * across the weekend. Both are allowed; this is which one to reach for
     * first. Zero makes the generator indifferent.
     */
    sameDayPenalty: z.number().min(0).default(1400),
    allowGameAndPracticeSameDay: z.boolean(),
    allowConsecutiveDays: ConsecutiveDays,
    /** Weekdays the league never plays on. */
    blockedWeekdays: z.array(Weekday).default([]),
    /** Every regular-season game must finish before the first playoff game. */
    regularSeasonEndsBeforePlayoffs: z.boolean(),
    /** Spread each team evenly across morning / midday / evening. */
    balanceTimeBands: z.boolean(),
    gamesOnPracticeIce: GamesOnPracticeIce,
    /** Only meaningful when capabilities.familyConstraints is on. */
    maxHouseholdGamesPerDay: z.number().int().min(1).default(1),
    /** Weekdays the league plays on. Empty means any day not blocked. */
    onlyWeekdays: z.array(Weekday).default([]),
    /** False means a team never faces a team from another division. */
    interDivisionPlay: z.boolean().default(false),
  }),

  timeBands: z.object({
    morningBefore: ClockTime,
    eveningFrom: ClockTime,
  }),

  standings: z.object({
    winPoints: z.number(),
    tiePoints: z.number(),
    lossPoints: z.number(),
  }),

  /** Rules we have not confirmed yet. Surfaced by the validator, never silent. */
  unknowns: z.array(z.string()).default([]),
});
export type LeagueManifest = z.infer<typeof LeagueManifest>;

const bands = { morningBefore: '12:00', eveningFrom: '17:00' };
const points = { winPoints: 2, tiePoints: 1, lossPoints: 0 };

export const HOUSE_LEAGUE: LeagueManifest = LeagueManifest.parse({
  id: 'house',
  name: 'Jr. Red Hawks House League',
  capabilities: {
    practices: true, playoffs: true, standings: true, crossIce: true, scores: true,
    familyConstraints: true,
  },
  week: { startsOn: 'monday' },
  scheduling: {
    defaultGamesPerTeam: 16,
    defaultPracticesPerTeam: 13,
    // One game a week is the promise; two is what February sometimes needs.
    // Tom's own 2026-27 schedule has 39 team-weeks with two games against 162
    // with one, and 16 games per team will not fit 15 weeks any other way.
    maxGamesPerWeek: 2,
    softGamesPerWeek: 1,
    maxPracticesPerWeek: 1,
    // Saturday and Sunday is the double everyone prefers, and the generator
    // reaches for it first. But a Sunday afternoon sheet that nobody can use
    // is a sheet the playoffs then do not get, so a second game the same day
    // is allowed when the wait is a reasonable one: long enough to come off,
    // eat and go again, short enough that nobody drives home in between.
    allowSameDayDoubleheader: true,
    sameDayRest: { minMinutes: 45, maxMinutes: 150 },
    sameDayPenalty: 1400,
    allowGameAndPracticeSameDay: false,
    allowConsecutiveDays: 'lateSeason',
    blockedWeekdays: [],
    regularSeasonEndsBeforePlayoffs: true,
    balanceTimeBands: true,
    gamesOnPracticeIce: 'lastResort',
    maxHouseholdGamesPerDay: 2,
    onlyWeekdays: [],
    interDivisionPlay: false,
  },
  timeBands: bands,
  standings: points,
  unknowns: [],
});

export const ADULT_LEAGUE: LeagueManifest = LeagueManifest.parse({
  id: 'adult',
  name: 'MSU Arena Adult League',
  capabilities: {
    practices: false, playoffs: true, standings: true, crossIce: false, scores: true,
    // Adult players are not households with children to ferry around.
    familyConstraints: false,
  },
  week: { startsOn: 'sunday' },
  scheduling: {
    defaultGamesPerTeam: 8,
    defaultPracticesPerTeam: 0,
    maxGamesPerWeek: 1,
    softGamesPerWeek: 1,
    maxPracticesPerWeek: 0,
    allowSameDayDoubleheader: false,
    allowGameAndPracticeSameDay: true, // no practices exist, so never binds
    allowConsecutiveDays: 'always',
    blockedWeekdays: ['friday', 'saturday'],
    regularSeasonEndsBeforePlayoffs: true,
    balanceTimeBands: false,
    gamesOnPracticeIce: 'never',
    maxHouseholdGamesPerDay: 99,
    onlyWeekdays: [],
    interDivisionPlay: false,
  },
  timeBands: bands,
  standings: points,
  unknowns: [],
});

export const MIDDLE_SCHOOL_LEAGUE: LeagueManifest = LeagueManifest.parse({
  id: 'middle_school',
  name: 'Middle School League',
  capabilities: {
    practices: false, playoffs: false, standings: true, crossIce: false, scores: true,
    // Siblings are matched within this league only, never against House.
    familyConstraints: true,
  },
  week: { startsOn: 'monday' },
  scheduling: {
    defaultGamesPerTeam: 10,
    defaultPracticesPerTeam: 0,
    maxGamesPerWeek: 1,
    softGamesPerWeek: 1,
    maxPracticesPerWeek: 0,
    allowSameDayDoubleheader: false,
    allowGameAndPracticeSameDay: true, // no practices exist, so never binds
    allowConsecutiveDays: 'always',    // Sat/Sun are adjacent by definition
    blockedWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday'],
    regularSeasonEndsBeforePlayoffs: true,
    balanceTimeBands: false,
    gamesOnPracticeIce: 'never',
    maxHouseholdGamesPerDay: 2,
    // Tom said "weekends"; the booked ice has 27 Friday-night slots labelled
    // "Middle School Game", so Friday is treated as a game night. Confirm.
    onlyWeekdays: ['friday', 'saturday', 'sunday'],
    interDivisionPlay: false,
  },
  timeBands: bands,
  standings: points,
  // Confirmed with Tom 2026-10-16: 10-game season, 14 teams, two divisions,
  // division-only play, weekends only, no practices, no playoffs, every game
  // at MSU Arena, season starts in November ahead of House.
  unknowns: [
    'No evaluations have been run for this league. If that changes, set '
      + 'evaluationSessions on each division; nothing else needs touching.',
    'Friday counts as a game night, taken from 27 booked Friday slots. Confirm, '
      + 'because the league was described as weekends only.',
    'The booked ice starts 5 December, not November. Confirm the season window.',
    'Two of the fourteen teams are still named as placeholders.',
    'No school blackout dates are set. Add exam weeks and school breaks.',
    'No latest finish time is set for a school night.',
  ],
});

export const MANIFESTS: Record<string, LeagueManifest> = {
  [HOUSE_LEAGUE.id]: HOUSE_LEAGUE,
  [ADULT_LEAGUE.id]: ADULT_LEAGUE,
  [MIDDLE_SCHOOL_LEAGUE.id]: MIDDLE_SCHOOL_LEAGUE,
};

export function manifestFor(leagueId: string): LeagueManifest {
  const m = MANIFESTS[leagueId];
  if (!m) {
    throw new Error(
      `Unknown league "${leagueId}". Known: ${Object.keys(MANIFESTS).join(', ')}. ` +
        `Add a manifest rather than branching on the id.`,
    );
  }
  return m;
}
