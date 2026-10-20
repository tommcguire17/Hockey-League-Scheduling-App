# League App

Ice scheduling and league operations for MSU Arena. One engine for the
**House**, **Adult** and **Middle School** leagues, with every difference
between them expressed as data in a league manifest rather than as code.

## The one rule

**No player data in this repository, ever.** Rosters carry minors' names,
birthdates and guardian email addresses. Anything bundled with a static site is
public. `data/` is gitignored, `saveSeason()` strips people by default, and CI
fails the build if player data is ever committed.

## Layout

```
packages/core     schema, league manifests, calendar maths, the validator
packages/engine   fixture generation and the scheduler (pure, seeded)
packages/io       CSV parsing, importers, SportNinja export, season load/save
apps/web          the console: open a season, generate, score, check, export
tools/            one-off migration and CLI scripts
fixtures/         synthetic sample data, safe to commit
data/             real season files — gitignored, never committed
```

`core` has no I/O and no UI. `io` depends on `core`. Nothing depends on a
browser, which is what keeps the engine testable and the UI replaceable.

Deploying it: see **DEPLOY.md**.

## Getting started

```bash
npm install
npm run check          # typecheck + 278 unit tests + the web build
npm run test:e2e       # 30 end-to-end tests against the real console
npm run dev            # the console at http://localhost:5173
npm run build:single   # dist/index.html — the whole console in one file
```

Three ways to start a season, none of which need a terminal:

- **Open** a `.season.json` saved earlier.
- **Start a new season** from the opening screen, then import a Finnly ice
  export and a team list as CSV on the Ice and Teams tabs.
- **Add ice and teams by hand**, a row at a time, for anything that never
  came from an export.

The console runs entirely in the browser. It opens and saves season files from
your own machine; nothing is uploaded and there is no server. `npm run build:web`
produces `apps/web/dist`, which is what GitHub Pages serves.

### Size

104 KB stored in git, 46 KB downloaded per visit. React is aliased to Preact
in `apps/web/vite.config.ts`; delete those four lines to go back to React and
the bundle returns to 84 KB gzipped. See ARCHITECTURE.md for the breakdown.

### Changing how it looks

Every colour, size and rule lives in `:root` at the top of
`apps/web/src/styles.css`. The palette is taken from an ice sheet — the surface,
its shadow, the dasher boards, and the painted blue and red lines — so changing
those six values restyles the whole console.

Build the Middle School season from the Finnly ice export and the team list:

```bash
npx tsx tools/js/build-msl.ts msl_ice.csv msl_teams.csv data/msl-2026-27.season.json
```

Generate a schedule into a season file, then export it:

```bash
npx tsx tools/js/generate.ts data/msl-2026-27.season.json [seed]
npx tsx tools/js/export.ts   data/msl-2026-27.season.json out/msl
```

Blackout dates: copy `fixtures/blackouts-template.csv`, fill it in, and pass it
as the fourth argument to `build-msl`. Both league-wide dates and per-team
dates are honoured by the generator, not just reported afterwards.

Migrate a season out of one of the standalone HTML schedulers. Export its JSON
from the app, then:

```bash
npx tsx tools/js/migrate-app.ts adult-export.json adult data/adult.season.json
```

Convert an existing schedule workbook into a season file:

```bash
python3 tools/workbook_to_season.py <workbook.xlsx> house data/my.season.json
```

Validate any season against its league's rules:

```bash
npx tsx tools/js/validate.ts data/my.season.json
```

Check whether two leagues have booked the same sheet of ice. Run this whenever
seasons overlap in time — Middle School starts in November and House runs to
March, so they compete for the same building:

```bash
npx tsx tools/js/conflicts.ts data/house.season.json data/middle-school.season.json
```

## The three leagues

| | House | Adult | Middle School |
|---|---|---|---|
| Practices | yes | no | no |
| Evaluations | per division | per division | per division |
| Week starts | Monday | Sunday | Monday |
| Plays on | any day | not Fri/Sat | Fri / Sat / Sun |
| Cross-ice | yes (8U) | no | no |
| Ice format | per division | per division | per division |
| Family constraints | yes | no | yes |
| Games per team | 16 | 8 | 10 |
| Games per week | 1 preferred, 2 allowed | 1 | 1 |
| Inter-division play | opt-in per pair | opt-in per pair | opt-in per pair |
| Playoffs | yes | yes | no |

Evaluations, where a league runs them, are the first thing that happens: a
division plays nothing until its last session is done, and a level with heavy
signups runs more than one.

Where playoffs run, each division sets how many teams qualify — 2, 3, 4, 6 or
8 — and the bracket is built, seeded from the standings and fitted into the
ice left after the regular season. Seeds are live: they move as results come
in and settle when the last regular-season game is scored.

## Adding a league

Add a manifest to `packages/core/src/manifest.ts`. Do not add a branch on
league id anywhere else — `manifestFor()` throws on an unknown league
specifically so that a missing manifest fails loudly instead of silently
falling back to House rules.

## Tests

| What | Where |
|---|---|
| Calendar maths, week boundaries, time bands | `packages/core/test/time.test.ts` |
| Fixture balance, round robins, home/away | `packages/engine/test/fixtures.test.ts` |
| Generated schedules across 12 seeds | `packages/engine/test/schedule.test.ts` |
| Away games, locked games, ice turnaround | `packages/core/test/invariants.test.ts` |
| Migration from the HTML schedulers | `packages/io/test/migrate.test.ts` |
| Standings, points and tiebreaks | `packages/core/test/standings.test.ts` |
| Bracket shapes, seeding and advancement | `packages/core/test/playoffs.test.ts` |
| Reading the Finnly Event Type column | `packages/io/test/iceImport.test.ts` |
| Practices, evaluations and reserved ice | `packages/engine/test/practices.test.ts` |
| Repurposing ice, and the handback to the rink | `packages/core/test/repurpose.test.ts` |
| Evaluations first, and older seasons that predate them | `packages/core/test/evaluations.test.ts` |
| Whether a season is ready to publish | `packages/core/test/readiness.test.ts` |
| Full, half and cross ice, and one sheet one division | `packages/engine/test/iceFormat.test.ts` |
| The soft weekly rule and where the doubles land | `packages/engine/test/weeklyLoad.test.ts` |
| Crossover play between divisions | `packages/engine/test/crossover.test.ts` |
| Finding ice for a bracket | `packages/engine/test/playoffs.test.ts` |
| Holding ice back so the playoffs have somewhere to play | `packages/engine/test/playoffIce.test.ts` |
| Ice marked "Playoff", and the squeeze that follows | `packages/engine/test/playoffIce.test.ts` |
| A second game in a weekend, and what makes the day bearable | `packages/core/test/invariants.test.ts` |
| The public page, including what must NOT be in it | `packages/io/test/publicPage.test.ts` |
| The console, driven in a real browser | `apps/web/e2e/console.spec.ts` |

CSV writers live in `packages/io/src/exportCsv.ts` and date and clock
formatting in `packages/core/src/time.ts`, each used by the CLI, the console
and the public page so the three can never disagree. `fmtTime()` is the only
place a clock time is turned into something a person reads: times are stored
as 24-hour strings because that is the only form that sorts and compares
correctly, and shown as "6:30 PM" because that is what a parent reads off a
phone at the rink. Division and team labels come from
`apps/web/src/lib/names.ts` for the same reason — nothing renders an id.
| League rules differ as data | `packages/core/test/manifest.test.ts` |
| Every validator rule, one test each | `packages/core/test/invariants.test.ts` |
| CSV edge cases and normalizers | `packages/io/test/csv.test.ts` |
| SportNinja golden file, round-trip, PII guard | `packages/io/test/export.test.ts` |

Regenerate the export golden file deliberately with `UPDATE_GOLDEN=1 npm test`.
