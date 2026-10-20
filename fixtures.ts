/**
 * Fixture generation: WHO plays WHOM, and how often. Dates come later.
 *
 * For n teams each playing g games inside their own division:
 *   full   = floor(g / (n-1))   complete round robins
 *   extra  = g - full*(n-1)     additional games per team
 * The extras form an `extra`-regular graph on n vertices, which exists when
 * extra*n is even. With 8 teams at 10 games that is one round robin (7) plus
 * a 3-regular graph (3 more each); with 6 teams at 10 it is exactly two round
 * robins and no extras at all.
 */

export interface Fixture { homeId: string; awayId: string; }

export class FixtureError extends Error {}

/** Circle-method round robin. Returns rounds; each round pairs every team. */
export function roundRobin(ids: readonly string[]): [string, string][][] {
  const t = ids.slice();
  if (t.length % 2 === 1) t.push('__BYE__');
  const n = t.length;
  const rounds: [string, string][][] = [];
  for (let r = 0; r < n - 1; r++) {
    const round: [string, string][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = t[i]!, b = t[n - 1 - i]!;
      if (a !== '__BYE__' && b !== '__BYE__') {
        // alternate orientation by round and position so home/away evens out
        round.push((r + i) % 2 === 0 ? [a, b] : [b, a]);
      }
    }
    rounds.push(round);
    t.splice(1, 0, t.pop()!);           // rotate, holding t[0] fixed
  }
  return rounds;
}

/** k-regular graph on n vertices as a circulant. Needs n*k even, k < n. */
export function regularGraph(n: number, k: number): [number, number][] {
  if (k === 0) return [];
  if (k >= n) throw new FixtureError(`cannot build a ${k}-regular graph on ${n} vertices`);
  if ((n * k) % 2 !== 0) {
    throw new FixtureError(
      `${n} teams cannot each play ${k} extra games: ${n} x ${k} is odd, ` +
      `so the games cannot be paired up. Change the game target or the team count.`);
  }
  const edges: [number, number][] = [];
  const half = Math.floor(k / 2);
  for (let d = 1; d <= half; d++) {
    for (let i = 0; i < n; i++) edges.push([i, (i + d) % n]);
  }
  if (k % 2 === 1) {
    if (n % 2 !== 0) throw new FixtureError('odd degree needs an even number of teams');
    for (let i = 0; i < n / 2; i++) edges.push([i, i + n / 2]);
  }
  return edges;
}

/**
 * Builds the full fixture list for one division, balancing home and away as
 * evenly as the numbers allow.
 */
export function buildFixtures(teamIds: readonly string[], gamesPerTeam: number): Fixture[] {
  const n = teamIds.length;
  if (n < 2) throw new FixtureError(`a division needs at least 2 teams, got ${n}`);
  if (gamesPerTeam <= 0) return [];
  if ((gamesPerTeam * n) % 2 !== 0) {
    throw new FixtureError(
      `${n} teams x ${gamesPerTeam} games = ${n * gamesPerTeam} team-games, which is odd. ` +
      `Every game uses two, so this cannot be scheduled.`);
  }

  const perRR = n - 1;
  const full = Math.floor(gamesPerTeam / perRR);
  const extra = gamesPerTeam - full * perRR;

  // 1. Collect unordered meetings with multiplicity.
  const pairs = new Map<string, { a: string; b: string; n: number }>();
  const bump = (a: string, b: string) => {
    const [x, y] = a < b ? [a, b] : [b, a];
    const k = `${x}|${y}`;
    const e = pairs.get(k) ?? { a: x, b: y, n: 0 };
    e.n++; pairs.set(k, e);
  };
  for (let rr = 0; rr < full; rr++) {
    for (const round of roundRobin(teamIds)) for (const [a, b] of round) bump(a, b);
  }
  for (const [i, j] of regularGraph(n, extra)) bump(teamIds[i]!, teamIds[j]!);

  // 2. Orient. A pair meeting an even number of times splits home and away
  //    exactly, which is what makes a double round robin perfectly balanced.
  const out: Fixture[] = [];
  const home = new Map(teamIds.map((id) => [id, 0]));
  const odd: { a: string; b: string }[] = [];
  const keys = [...pairs.keys()].sort();
  for (const k of keys) {
    const { a, b, n: times } = pairs.get(k)!;
    const half = Math.floor(times / 2);
    for (let i = 0; i < half; i++) {
      out.push({ homeId: a, awayId: b });
      out.push({ homeId: b, awayId: a });
      home.set(a, home.get(a)! + 1);
      home.set(b, home.get(b)! + 1);
    }
    if (times % 2 === 1) odd.push({ a, b });
  }

  // 3. The leftover single meetings form a graph that must be ORIENTED so that
  //    every team ends up with as near to half its games at home as possible.
  //    Greedy does not achieve that. Orienting along an Eulerian circuit does:
  //    walking a closed trail gives every vertex equal in- and out-degree.
  for (const [h, v] of orientBalanced(teamIds, odd)) {
    out.push({ homeId: h, awayId: v });
    home.set(h, home.get(h)! + 1);
  }

  return out;
}

/**
 * Orients an undirected multigraph so each vertex's out-degree is as close to
 * half its degree as possible. Vertices of odd degree are paired through a
 * dummy vertex so an Eulerian circuit exists; those dummy edges are dropped,
 * leaving at most a one-game imbalance and only where the degree is odd.
 */
export function orientBalanced(
  vertices: readonly string[], edges: readonly { a: string; b: string }[],
): [string, string][] {
  const DUMMY = '__DUMMY__';
  type E = { u: string; v: string; id: number; used: boolean };
  const all: E[] = edges.map((e, i) => ({ u: e.a, v: e.b, id: i, used: false }));

  const deg = new Map<string, number>();
  for (const v of vertices) deg.set(v, 0);
  for (const e of all) {
    deg.set(e.u, (deg.get(e.u) ?? 0) + 1);
    deg.set(e.v, (deg.get(e.v) ?? 0) + 1);
  }
  const oddV = vertices.filter((v) => (deg.get(v) ?? 0) % 2 === 1).sort();
  let id = all.length;
  for (const v of oddV) all.push({ u: DUMMY, v, id: id++, used: false });

  const adj = new Map<string, E[]>();
  const push = (k: string, e: E) => (adj.get(k) ?? adj.set(k, []).get(k)!).push(e);
  for (const e of all) { push(e.u, e); push(e.v, e); }

  const out: [string, string][] = [];
  const seen = new Set<number>();
  const starts = [...adj.keys()].sort();
  for (const start of starts) {
    if ((adj.get(start) ?? []).every((e) => e.used)) continue;
    // Hierholzer
    const stack: string[] = [start];
    const trail: string[] = [];
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const nxt = (adj.get(top) ?? []).find((e) => !e.used);
      if (!nxt) { trail.push(stack.pop()!); continue; }
      nxt.used = true;
      stack.push(nxt.u === top ? nxt.v : nxt.u);
    }
    trail.reverse();
    for (let i = 0; i + 1 < trail.length; i++) {
      const a = trail[i]!, b = trail[i + 1]!;
      if (a === DUMMY || b === DUMMY) continue;
      // find the matching unconsumed edge between a and b
      const e = (adj.get(a) ?? []).find(
        (x) => !seen.has(x.id) && ((x.u === a && x.v === b) || (x.u === b && x.v === a)));
      if (!e) continue;
      seen.add(e.id);
      out.push([a, b]);
    }
  }
  return out;
}

/** How many times each unordered pair meets. */
export function meetingCounts(fs: readonly Fixture[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of fs) {
    const k = [f.homeId, f.awayId].sort().join('|');
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

export interface CrossTeam { id: string; divisionId: string }

export interface CrossResult {
  fixtures: Fixture[];
  /** Teams that could not be given their full share, and how many are missing. */
  short: { teamId: string; got: number; wanted: number }[];
}

/**
 * Fixtures BETWEEN divisions that have agreed to cross over.
 *
 * Within a division the shape is known — a round robin plus a regular graph —
 * because every team wants the same number of games against the same pool.
 * Across divisions it is a degree-constrained subgraph: every team needs
 * exactly `wanted[team]` games, none of them against its own division, and
 * the divisions are rarely the same size. There is no neat circulant for
 * that, so this is a greedy with a deterministic order: repeatedly take the
 * team furthest from its quota and pair it with the eligible opponent that is
 * also furthest from theirs, breaking ties towards the pair that have met
 * least and then by id so the result is reproducible.
 *
 * Returns what it could not do rather than throwing: a crossover group with
 * one large division and one small one simply cannot give everyone the same
 * number of cross games, and the caller should say so, not fail.
 */
export function crossFixtures(
  teams: readonly CrossTeam[], wanted: ReadonlyMap<string, number>,
): CrossResult {
  const need = new Map<string, number>();
  for (const t of teams) need.set(t.id, Math.max(0, wanted.get(t.id) ?? 0));
  const divOf = new Map(teams.map((t) => [t.id, t.divisionId]));
  const met = new Map<string, number>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  /** How often a team has already drawn each opposing division. */
  const metDiv = new Map<string, number>();
  const divKey = (team: string, div: string) => `${team}>${div}`;

  const pairs: { a: string; b: string }[] = [];
  const order = [...need.keys()].sort();

  for (;;) {
    // The team with most left to do goes first; it has the fewest ways left
    // to be satisfied, so serving it last is how teams end up short.
    let pick = '';
    let most = 0;
    for (const id of order) {
      const n = need.get(id)!;
      if (n > most) { most = n; pick = id; }
    }
    if (!pick) break;

    let best = '';
    let bestScore = -Infinity;
    for (const other of order) {
      if (other === pick) continue;
      if (divOf.get(other) === divOf.get(pick)) continue;
      const left = need.get(other)!;
      if (left <= 0) continue;
      // Hungriest first, but spread across DIVISIONS before repeating one:
      // scoring on hunger alone paired D1 with D2 every time and left D3 and
      // D4 to each other, which is the opposite of keeping fixtures fresh.
      const seenDiv = metDiv.get(divKey(pick, divOf.get(other)!)) ?? 0;
      const seenPair = met.get(pairKey(pick, other)) ?? 0;
      const score = left * 20 - seenDiv * 400 - seenPair * 60;
      if (score > bestScore) { bestScore = score; best = other; }
    }
    if (!best) {
      // Nobody eligible is still hungry. This team cannot be finished.
      need.set(pick, 0);
      continue;
    }

    const k = pairKey(pick, best);
    met.set(k, (met.get(k) ?? 0) + 1);
    metDiv.set(divKey(pick, divOf.get(best)!), (metDiv.get(divKey(pick, divOf.get(best)!)) ?? 0) + 1);
    metDiv.set(divKey(best, divOf.get(pick)!), (metDiv.get(divKey(best, divOf.get(pick)!)) ?? 0) + 1);
    need.set(pick, need.get(pick)! - 1);
    need.set(best, need.get(best)! - 1);
    // Orientation comes later, from the Eulerian pass, which balances home
    // and away exactly. Choosing it here, pair by pair, cannot: the first
    // pair has nothing to balance against.
    pairs.push({ a: pick, b: best });
  }

  // Same Eulerian orientation the within-division fixtures use, so a team's
  // home and away games come out even across the crossover too.
  const fixtures: Fixture[] = orientBalanced(order, pairs)
    .map(([homeId, awayId]) => ({ homeId, awayId }));

  const done = new Map<string, number>();
  for (const f of fixtures) {
    done.set(f.homeId, (done.get(f.homeId) ?? 0) + 1);
    done.set(f.awayId, (done.get(f.awayId) ?? 0) + 1);
  }
  const short = teams
    .map((t) => ({ teamId: t.id, got: done.get(t.id) ?? 0, wanted: wanted.get(t.id) ?? 0 }))
    .filter((x) => x.got < x.wanted);

  return { fixtures, short };
}
