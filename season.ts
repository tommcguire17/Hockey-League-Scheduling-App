import { Season, markEvaluationIce, withoutPeople } from '@league/core';

/**
 * Reads a season file. Parse errors name the offending field.
 *
 * Seasons written before evaluations had a slot use of their own kept the
 * session and the ice out of step; markEvaluationIce reconciles them on the
 * way in, so an older file gains the evaluation ice it always had rather
 * than being told it has none.
 */
export function loadSeason(json: string): Season {
  return markEvaluationIce(Season.parse(JSON.parse(json)));
}

/**
 * Serializes a season. People are omitted unless explicitly requested, so the
 * default path can never write player data into a file destined for git.
 */
export function saveSeason(season: Season, opts: { includePeople?: boolean } = {}): string {
  const out = opts.includePeople ? season : withoutPeople(season);
  return JSON.stringify(out, null, 2);
}

/** Round-trip identity: load(save(x)) deep-equals x. Pinned by a test. */
export function roundTrip(season: Season): Season {
  return loadSeason(saveSeason(season, { includePeople: true }));
}
