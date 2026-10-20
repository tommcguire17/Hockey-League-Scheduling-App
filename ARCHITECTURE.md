# Architecture

## Why it is shaped this way

The previous tools were single HTML files with the scheduling logic, the data
and the UI in one place. They worked, but every failure in this project came
from the same two places: **the import boundary** and **ranges that silently
stopped covering the data**. Examples, all real:

- A tab renamed `Schedule` → `Game Schedule` broke cross-sheet formulas.
- A rink typed `Rocky` in some rows and `Rocky Rink` in others made the
  by-rink totals short by seven slots and would have broken a SportNinja upload.
- `NaN is not None` is true in Python, so blank number preferences were
  assigned as real jersey numbers.
- Formula ranges stopped at row 123 after rows were inserted, so Setup
  undercounted games and Standings would have ignored scores on 14 rows.

Every one of those is a class of bug, not a one-off. The architecture targets
the classes.

## The three decisions

**1. Parse, don't validate.** Every importer returns typed objects parsed by a
Zod schema, or fails naming the offending field. `Header.require()` throws with
the list of columns actually present rather than returning `undefined`. A
renamed column is now a loud failure at import, not a wrong number three tabs
away.

**2. Rules are data.** `LeagueManifest` holds every difference between the
leagues: whether practices exist, which day a week starts on, which weekdays
are blocked, whether same-day doubleheaders are allowed, how time bands are
defined, how points are awarded. The validator reads the manifest and nothing
else. There is no `if (league === 'adult')` in the codebase, and
`manifestFor()` throws on an unknown league so a missing manifest cannot
silently inherit House rules.

Unconfirmed rules are data too. `MIDDLE_SCHOOL_LEAGUE.unknowns` lists what we
have not verified, and the validator surfaces each as a warning. Placeholders
announce themselves instead of hiding as plausible defaults.

**3. The engine is pure.** `validateSeason(season, manifest)` takes data and
returns findings. No clock, no randomness, no file system, no DOM. That is what
makes it testable, and what will let the UI be replaced without touching logic.

## Data model

```
Season
 ├─ Division[]        targets, overriding the manifest per division
 ├─ Team[]            blackout dates, allowed weekdays
 ├─ Slot[]            a booked piece of ice: date, start, minutes, rink,
 │                    use, capacity (2 = cross-ice), practiceTeams, owner
 ├─ Game[]            division, slot, home/away team or bracket label, type, score
 ├─ Practice[]        slot plus the teams on it; kind separates evaluations
 └─ Person[]          PII. Never serialized unless explicitly requested.
```

`Slot` is the atom everything competes for, which is what lets capacity,
overbooking and cross-ice be checked in one place.

`Person.householdId` is the hook for scheduling families rather than teams.
It is currently derived from a shared guardian email, which is a proxy; it
should be replaced by Finnly's real household id as soon as that export exists.

## What the validator checks

Structural: duplicate ids, orphan references, capability mismatches.
Ice: slot overbooking, games on practice or out-of-play ice, practice slots
over their team limit.
Per team: game and practice counts against target, time-band balance,
same-day doubleheaders, game-and-practice-same-day, blackout dates, allowed
weekdays, league-blocked weekdays, games outside the season window, games per
scheduling week, repeat-opponent runs, back-to-back days.
Season: playoffs overlapping the regular season.
League weekdays: `blockedWeekdays` (never play) and `onlyWeekdays` (play only
these), which is how Middle School is pinned to weekends.
Households: when `capabilities.familyConstraints` is on, a household with
children on different teams is flagged if it is pulled to the rink more times
in one day than `maxHouseholdGamesPerDay`. Matching happens WITHIN a league
only; House and Middle School households are never matched against each other,
and Adult ignores households entirely.
Divisions: a game between teams from different divisions, when the manifest
keeps play inside a division.
Arithmetic: team-games must equal exactly twice the number of placed games.

`findIceConflicts(seasons[])` is separate from `validateSeason`, because no
single season can see the problem. It keys on the physical ice (date, start,
rink) rather than slot id, since every season mints its own ids at import.

## The scheduler

`generateSchedule(season, manifest, { seed })` is pure and deterministic: same
inputs and seed, same schedule, which is what lets a change be explained as a
diff. It runs in four stages.

1. **Fixtures.** Who plays whom, before any dates exist. `full` complete round
   robins plus an `extra`-regular graph for the remainder. Orientation is the
   subtle part: a pair meeting twice splits home and away, and the leftover
   single meetings are oriented along an **Eulerian circuit**, which gives every
   team an equal in- and out-degree. Greedy orientation left two teams at 6-4;
   the Eulerian pass puts all fourteen at exactly 5-5.
2. **Greedy placement**, week by week, with a soft quota of
   `remaining / weeksLeft`. Without the quota the greedy fills December solid
   and starves March, which is what forces repeat matchups into consecutive
   weeks.
3. **Fill, then repair.** The quota must never cost a game, so a second pass
   places anything left over in any legal free slot, and a third pass moves a
   blocking game aside when a fixture is stranded by an earlier placement
   rather than by a lack of ice.
4. **Local search** to spread repeat matchups and even out late starts. Most
   proposals are same-week swaps, because a cross-week swap is nearly always
   vetoed by the one-game-per-week rule — with only cross-week moves the search
   was effectively frozen.

## The console

`apps/web` is a Vite + React app that imports the engine directly, so the
scheduler runs in the browser with no server and no upload. Season files are
opened and saved from the person's own machine through a file input and a blob
download, which works in every browser (the File System Access API does not).

The visual language comes from the rink rather than from dashboard convention:
the pale cold white of a fresh sheet, the blue-grey of ice under the lights,
the dasher boards as chrome, and the painted blue and red lines doing
structural work — the blue line rules a table header, the red line marks the
bottom of the top bar and every error. Every token sits in `:root` in
`styles.css`, so restyling means editing six colours, not hunting through
components.

The landing view is the season strip: one column per week, total height for
ice booked and a blue fill for games placed. It answers the question the app is
actually opened to answer — is this season full, and where is the slack —
which a row of stat cards does not.

## Away games, locked games, and what "scheduled" means

`Game.slotId` alone could not say whether a game had no ice yet or was simply
played somewhere else. Both looked like "unplaced". So a game now carries
either a `slotId` or an `away` venue, never both:

- an away game consumes none of our ice, but both teams still count it and are
  busy that day and that week;
- our weekday rules, season window and league blackouts apply to our ice only.
  A team's own blackout dates still apply wherever it plays;
- `Game.locked` pins a fixture the generator must not move.

Everything that asks "is this team busy?" goes through `gameWhen()`, so an away
game can never be mistaken for free time. The generator keeps away and locked
games exactly where they are, subtracts them from each division's fixture
requirement, and schedules the rest around them.

## Editing by hand

The console's game editor runs the whole validator against every candidate
move before offering it, and shows the resulting error as the reason a slot is
unavailable. On a full schedule no slot is empty, so the only useful action is
a straight swap with the game already there — the editor offers that too, and
validates it the same way. An end-to-end test covers it, because without the
swap the editor is a dead end exactly when it is needed most.

## Results, changes, and the page families see

**Scores** live on the game (`homeGoals` / `awayGoals`); a game counts as played
once both are set, so 0-0 is a real result rather than an empty one.
`standings()` builds the table from them, taking points from the manifest
rather than assuming two for a win, and ranking on points, goal difference,
goals for, head to head, then name — a total order that never depends on array
position. Playoff games are excluded. An away game counts exactly like a home
one.

**Changes are kept, not overwritten.** Moving a game in the editor records what
it was, what it became, when that was decided and why, from a fixed list of
reasons. `describeMove()` returns null when nothing actually moved, so saving
an unchanged game adds no noise. This exists because "the schedule changed and
nobody knows why" is the complaint that costs a season's goodwill.

**The public page** is a single self-contained HTML file: schedule, results,
standings and the change log, filterable by team and division, printable. It
loads nothing from anywhere — no fonts, no scripts, no analytics — and carries
no player names, birthdates or contact details. Tests assert both of those
directly, and that a team name containing markup is escaped rather than
rendered.

## Playoffs

A bracket is **held in the games themselves**, not in a parallel structure
alongside them. Each bracket game carries `homeFrom` / `awayFrom`, which say
either "the team seeded 3rd in this division" or "whoever wins game `po-12U-sf1`".
Read a season file on its own and the whole bracket is legible; there is no
second thing to keep in step, and `schemaVersion` did not have to move, because
both fields default to null on every game that came before them.

`bracketTemplate(size, consolation)` is a table, not a search: 2, 3, 4, 6 and 8
qualifiers, standard seeding, byes to the top seeds, the better seed at home,
and a third-place game only where two semifinal losers actually exist. It
returns nodes in dependency order so a bracket can be built in one pass.

`resolveBracket()` fills in every team that can be known right now and nothing
else — seeds off the live standings, winners off played games. It is pure and
returns the *same object* when nothing moved, which is what lets the console
run it after every keystroke in the scores table. Three rules keep it honest:
a tie advances nobody; a game that is locked or already played keeps its teams;
and a score typed into a bracket slot whose teams are still unknown does **not**
freeze it empty — that was a real bug, caught by a test, and the console now
also disables those score boxes.

**Finding ice is planned backwards from the final.** Working forwards, every
division takes the earliest ice it can for round one, and the last division to
ask ends up with semifinals and nowhere to play its final. So finals are placed
first, on the latest ice available, and each earlier round is fitted in behind
the round it feeds; within a round the division with the fewest workable nights
goes first. A round is kept on one night wherever the ice allows, because that
is how a rink runs a semifinal double-header. Cross-ice capacity counts: a
capacity-2 slot in a league with `crossIce` holds both 8U semifinals at once.

The whole bracket is then planned under a **cutoff that walks forward** from the
first available night and stops at the first value that fits everything, so the
playoffs stay compact instead of sprawling to the end of the booked ice.

When it does not fit, nothing is silently dropped: the games are still created
without ice, the validator reports `PLAYOFF_NO_ICE`, and the run report names
the obstruction rather than shrugging — ice reserved for another division is
the usual culprit and it says which slot. On the real House season that is
exactly what happened: 15U is one pre-final slot short because the 14 March
07:00 sheet is reserved for 8U.

`generateSchedule()` treats bracket games as fixed, alongside away and locked
games. Before that it wiped them on every regenerate.

### "Playoff" as a slot use

The strongest way to hold ice back is to say so. `SlotUse` has a `playoff`
value alongside `game`, `practice`, `evaluation` and `unused`, set per slot on
the Booked Ice tab or by a standing ice rule, and the Finnly importer maps
`playoff`, `post-season`, `championship`, `quarterfinal`, `semifinal` and
`final` event types onto it.

It is a game sheet the **regular season may not touch**: `playableGameIce()`
returns only `use === 'game'`, so the generator cannot see it, and the
validator raises `REGULAR_ON_PLAYOFF_ICE` if one ends up there by hand. The
bracket allocator reads `GAME_USES` (`game` + `playoff`) instead, and when any
slot is marked it treats those nights as the pool, falling back to ordinary
game ice only if the marked nights cannot hold the brackets — and saying so
when it does. Otherwise a semifinal lands on a spare February sheet while the
weekend somebody set aside for it sits empty.

This is how a rink sets the end of its regular season: mark the last weekends,
and the rest of the season has to fit in front of them. The doubled-up
weekends follow from the marking rather than from the engine's guess, which is
the point — it is a decision, made in one place, visible on the ice list.
`planPlayoffIce()` detects marked ice and returns it as the window verbatim;
everything below is the fallback for a season nobody has made that decision
about.

### Holding ice back for the playoffs

A regular season generated without a reservation spreads across every night of
booked ice, because spreading out is what makes a schedule pleasant. It is also
what leaves the brackets with nowhere to play, since a bracket game may only go
on ice **after** its division's last regular game. On Tom's House season the
generator finished the regular season on 21 March — the final night of booked
ice — and then placed **zero of sixteen** bracket games. Both halves worked
exactly as written and the season was unusable.

So `planPlayoffIce()` (`packages/engine/src/playoffIce.ts`) reserves the last
few nights of game ice *before* the regular season is placed, and the regular
season is fitted into what is left. That is what produces the second game in a
week the rink was always going to need: the same games into fewer nights. The
soft weekly rule already prices a double cheapest late in the season, so the
doubles land in February and March rather than November.

**How wide the window has to be is not arithmetic, so it is not computed as
arithmetic.** Sixteen bracket games do not need sixteen openings on any sixteen
nights: a semifinal cannot share a night with the final it feeds, a sheet
reserved for 10U is no use to 12U, and a cross-ice sheet holds two games for one
division and one for another. Any approximation of those rules here would be a
second, worse copy of the allocator — and a copy that reads "16 games, 16
openings, fine" hands back a season whose playoffs then do not fit, which is the
original bug wearing a different hat. So **the allocator is the oracle**: for a
candidate window, ask `generatePlayoffs()` to place every bracket as though the
regular season had ended the night before, and believe the answer. The walk
starts at the last night and takes one more at a time, stopping at the fewest
that work. It costs about 30 ms, 1% of a generate.

**The reservation yields rather than starving the regular season.** Once the
fixture list is known, the earliest reserved nights are handed back until the
remaining ice can actually hold the regular season — never below the deepest
bracket's round count. Without this the two fight: reserving nights the regular
season then eats makes the answer depend on which pass ran last, and the
schedule moves between regenerates for no reason the rink can see. Reserved
openings also stay in `slots`, last in date order, so the fallback passes spill
into the reserve rather than drop a fixture. A missing playoff night is a
problem the rink can solve by booking ice; a deleted game is a lie.

Whatever is still short is a shortage of **booked ice**, and is reported as one:
the run report states the demand against what the rink has booked, and
`suggestRepurpose()` names the specific practice slots to flip. Practice nights
after the regular season ends are the obvious candidates — nobody is practising
once the season is over.

#### A second game in a weekend

One game a week is the promise; a weekend double is the exception a rink makes
deliberately to fit a season into the ice it has. `softGamesPerWeek` prices it
and `maxGamesPerWeek` caps it, but neither says anything about what the day
looks like, and the shape of the day is what families notice.

Saturday and Sunday is the arrangement everyone prefers, so the generator
reaches for it first: `sameDayPenalty` makes two games on one day cost more
than the same two split across the weekend, in both the greedy and the local
search. Where only one day is available, `sameDayRest` decides whether the
pair is one a family could actually do, measured from the end of the first
game to the start of the second:

- below `minMinutes` (45) they come off the ice and go straight back on;
- above `maxMinutes` (150) there is nothing to do but sit in the rink for the
  afternoon, or drive home and drive back — two or three slots between games
  is already past that line;
- below zero they overlap, which is not a long day but an impossible one.

`sameDayVerdict()` in `core/time.ts` is the single implementation, read by the
generator when it places and by the validator afterwards (`SAME_DAY_GAP`, a
warning for a bad wait and an error for an overlap). Leagues that ban the
pair outright keep `allowSameDayDoubleheader: false` and get
`SAME_DAY_DOUBLEHEADER` as before.

The practical effect on Tom's season: thirteen Sunday 4:00 PM sheets sat empty
from January to February because every team that could have used them already
played earlier that day. Twelve of the thirteen are now usable, which is
twelve regular-season games out of March and twelve nights of March ice the
brackets can have.

#### What the House season can actually hold

Measured on `data/msu-2026-27.season.json` (120 booked game slots, four
divisions of four teams, 4-team brackets, 8U at 12 games):

| Games per team (10U/12U/15U) | Regular games | Playoff games placed | Doubles |
|---|---|---|---|
| 16 | 120 | **7 of 16** | 24 |
| 15 | 114 | **13 of 16** | 24 |
| **14** | 108 | **16 of 16** | 17 |
| 13 | 102 | 16 of 16 | 16 |

Sixteen games a team needs 136 game openings and the rink has booked 120.
Flipping the late practice ice does not close it, because those slots are single
sheets on weeknights and a two-game round cannot go on a one-sheet night.
**Fourteen is the number that fits the ice as booked**, with the regular season
ending 6 March and the finals on 21 March. This is a booking decision, not a
scheduling one, which is why the app reports it rather than choosing.

## Practices, evaluations and whose ice it is

Three things went wrong at once in the first real test, and they had one
cause between them: **the booked-ice CSV carries more than dates, and the app
was throwing it away.**

`Event Type` says "YHL Game", "YHL Practice", "YHL Evaluations - u10". The
importer read that column, stored it as a tag, and then set every slot to
`game` regardless — so 78 practices arrived as games and had to be corrected
by hand. It now reads the type (`useFromEventType`) and, where the text names
one, the division too (`divisionFromEventType`), which is how five evaluation
sheets land on the right age group without anyone tagging them.

**Evaluations are their own `SlotUse`**, not a flavour of practice. The whole
division is on the ice at once, no game may ever be put there, and the
validator says which division has no evaluation ice — on the real export that
is 8U, whose session is booked as a Sunday 7am game slot and so is invisible
to the type column.

**The engine never generated practices at all.** It produced games and
returned; the empty practice list on the Schedule was not a display bug. The
new `assignPractices` does not search, because practice ice is not a search
problem: a rink books a standing weekly slot per age group and a team keeps
the same night all season, because that is what families plan around. So each
team is handed a home night and kept there, moving only when its own night is
unusable. On the real House export that produces exactly 12 or 13 practices
for every one of the sixteen teams, with no team over or under.

**`practiceTeams` of 0 means auto.** It used to default to 1, so one age
group's practice night held one team and left the other three with nothing.
Zero now means "however many the division needs that week", which is what a
sheet of ice actually holds.

### Reserved ice that releases

`ownerDivisionId` was a permanent lock. A rink does not work that way: 7am
Sunday is 8U's until 8U has its games, and then it is anybody's — held ice
nobody can use is ice sold to no one. `ownerPolicy` says which it is,
`priority` by default, and the greedy both prefers the owner in its own ice
and opens the slot the moment the owner has nothing left to place. The
local search then freezes what the owner won, because by the end every
fixture is placed and the release test would otherwise wave anyone through.

This also fixed the playoff shortfall found earlier: the 14 March sheet
reserved for 8U now releases to 15U once 8U is done.

### Ice rules

Two hundred rows of date and time is not how a rink thinks. `IceRule` holds
the standing bookings — weekday, start, use, division, policy, cross-ice
capacity — and `applyIceRules` stamps them onto the slots; `suggestIceRules`
reads the booked ice and proposes one rule per repeating weekday-and-time, so
the table starts filled in and Tom only chooses the division. It is visible
and auditable, which is what he actually asked for: he could not tell whether
the reservations had been applied correctly, and now the table says how many
slots each rule matched.

### Evaluations come first

Tom's rule, in his words: evaluations are always the first event of a season,
a level runs more than one session when signups are heavy, and Adult and
Middle School have never needed them — but parity might be wanted later. All
three are in the model rather than in anyone's head.

**The ordering is a hard invariant, not a convention.** `playFloors()` returns
the date of each division's LAST evaluation, and nothing that division does —
game or practice — may fall on or before it. It is a floor per division, so an
age group that finishes evaluating in November starts in November while
another is still waiting. The generator and the practice assigner both consult
it before placing anything, and `PLAY_BEFORE_EVALUATION` is an error, because
a season with a game before its evaluation is not slightly wrong, it is
unusable.

**Sessions are per division.** `Division.evaluationSessions` is usually 1 and
2 where signups are heavy. The validator says when the booked ice is short of
it, and the suggester offers that many sheets plus a couple of alternatives,
because which hour the skate sits in is a judgement about what families
expect and not the app's call.

**Leagues opt in.** `capabilities.evaluations` is false by default, true for
House only. A new league does not silently acquire evaluations, and giving
Middle School parity later is one flag.

**Older seasons reconcile themselves.** A season written before evaluations
had a slot use of their own carries the session as a practice of kind
`evaluation` while the slot still says `practice` or `game`, so the app would
have told Tom he had no evaluation ice when he plainly did.
`markEvaluationIce()` runs on load, marks the ice, and records what it was
booked as — which turns the real 2026-27 season's six evaluations into six
properly recorded repurposes, including the 8U skate on the 7am Sunday game
sheet. The session count follows the ice that was actually booked, so a level
that ran two reads as two rather than as "2 of 1".

Checked against the real season: every division's first game and first
practice already falls after its own evaluations, which is the rule holding in
data nobody wrote it for.

### Met or not met, rather than a tally

Evaluations started as a per-division count and became a question: is this
division ready? The count needed maintaining by hand and, once set, could
drift out of step with the booked ice; the question answers itself. That shape
turned out to generalise, so `readiness.ts` now applies it to the whole
season — teams, games, practices, evaluations, playoffs, errors — as a list of
conditions that each say met or not met and what is missing, in words.

The percentage this produces has a denominator nobody maintains: how many
conditions apply. A league without playoffs is not asked about playoffs, so it
is not quietly rewarded for not having them either. 100% means there is
nothing left to do.

This is a different question from the one the validator answers, and both are
worth having. "Eighty-one warnings" is what you want while building a
schedule and exactly what you do not want when deciding whether to publish
one.

### Repurposing a slot

The 8U game sheet at 7am Sunday is run as the evaluation skate, deliberately:
that is the hour parents already look for, so the season opens where they
expect it. That is not a data-entry mistake to be warned about, it is how a
rink hits its dates with the ice it has.

So a slot carries both answers. `use` is what is happening on it; `bookedUse`
is what the building booked, recorded on import and never overwritten by a
later change of mind, so the comparison stays true however many times we
rethink it. `repurposeNote` says why. Three things follow:

1. **A rules pass leaves it alone.** `applyIceRules` skips repurposed slots by
   default, because a standing rule is a general statement and this was a
   specific decision. It reports how many it skipped.
2. **A fresh Finnly export does not undo it.** The import keeps our use, and
   lists every slot where the file and the season disagree.
3. **The rink gets it back.** `exportIceDifferencesCsv` is the handback:
   booked against actual, who is on the ice, and why — for whoever keeps the
   booking system, so the front desk is not surprised by a parent.

Families see it too. The public page now carries practices and evaluations
alongside games, each labelled, so a session run on a sheet booked as a game
reads as an evaluation to the person it is for.

### Suggesting ice rather than taking it

Every shortfall — practices short, a game with nowhere to go, a playoff round
without ice — now comes with the specific slots that would fix it, ranked by
what they cost: out-of-play ice first, then ice with nothing booked on it,
then ice teams are relying on. Ice another division holds outright is never
offered, and ice with a game on it is offered only when the ice itself is the
point and there is spare game ice for the game to move to — which is exactly
the evaluation case, since the hour families expect is usually booked as a
game.

`suggestRepurpose` only proposes. Nothing changes until someone presses the
button, which was a deliberate choice: a generator that quietly re-labels the
building's ice to make its own numbers work is not one anybody should trust.

### Crossover play

Play stays inside a division unless two divisions say otherwise. That was
previously structural — fixtures are built per division from one team list —
and `interDivisionPlay` in the manifest was read by the validator and shown on
Overview but never by the generator, so it looked like a switch that was not
wired to anything.

Now it is opt-in per division and per pair: `playsAcross` names the divisions
this one may meet, and `crossGamesPerTeam` says how many of its games are
against them. The count comes **out of** `gamesPerTeam`, not on top, so the
season does not get longer. The relation is read both ways and treated as
transitive, which is what "four D divisions" means: pair them and they are one
pool.

Two guards that matter more than they look:

- **Formats must match.** 8U cross-ice cannot meet 15U full-ice, because a
  sheet is set up one way at a time. The pairing control is disabled for a
  mismatched pair and `CROSSOVER_FORMAT_MISMATCH` catches it in data.
- **Pairing writes both ways.** Setting it on one division only would read as
  done while half the pair did not know.

Inside a division a fixture list is a round robin plus a regular graph,
because everyone wants the same number of games against the same pool. Across
divisions it is a degree-constrained subgraph — every team needs its quota,
none of it against its own division, and the divisions are rarely the same
size — so `crossFixtures` is a deterministic greedy. Scoring on hunger alone
paired D1 with D2 every time and left D3 to D4, which is the opposite of
keeping fixtures fresh, so it also spreads across *divisions* before repeating
one. Orientation then goes through the same Eulerian pass the within-division
fixtures use, because choosing home and away pair by pair cannot balance: the
first pair has nothing to balance against.

Lopsided divisions cannot give everyone the same number of crossover games, so
it reports who fell short instead of failing, and the within-division count is
topped up from what the crossover actually delivered.

On four D-level divisions of four teams at eight games with three crossover
each: every team gets exactly 8 games and exactly 3 of them across, all six
division pairings used equally, home and away even, zero errors, and the
standings stay four separate tables.

### How a division splits the ice

Full ice is one game on the sheet, half ice is two across the width,
cross-ice is three in the zones. **This is a property of the age group, not
of the booking** — every team in a division plays the same way — so it is set
once on the division and every slot they use follows from it. `Slot.capacity`
survives as an override for the odd booking, with 0 meaning "work it out",
the same convention as `practiceTeams`.

That replaced a number on all 196 slots with one setting on each of four
divisions, and it closed a hole nobody had noticed. Capacity was a property
of the slot alone, so a sheet with room for two games would take one from any
division: in a two-division test, **four sheets out of eight ended up holding
two different divisions at once**. Physically impossible — a sheet is set up
one way at a time — and invisible in production only because capacity was 1
almost everywhere.

The fix is one rule in the clash predicate: a sheet belongs to the first
division on it, and holds as many of that division's games as its format
allows. Games the generator may not move — away, locked, bracket — count
toward that too; they are not in the search's own assignment map, so checking
only what the search had placed left the other half of a split sheet open to
anybody. `SLOT_SPLIT_BETWEEN_DIVISIONS` catches it in data the generator did
not produce.

Format is an allowance, not a target: a four-team division can only play two
games at once whatever its format, and the generator spreads across sheets
while there is spare ice, packing three onto one only when the ice is tight.

### Cross-ice, properly

The generator keyed its assignment by slot, so a sheet held one game whatever
its capacity said. It is now keyed by *opening* — a capacity-2 slot offers two
— which is what lets 8U play twelve cross-ice sessions on twelve sheets
instead of twenty-four.

That change surfaced a latent bug in the repair pass: it validated each of its
two moves before making the other, so the pair was never tested against each
other, and the same matchup could land twice on one day with each half legal
on its own. Both moves are now made first and checked after.

## What the SportNinja template taught us

Our exporter had Location and Facility the wrong way round for weeks, and a
test asserted the mistake. SportNinja's own template settles it: Location is
the building, Facility is the sheet of ice. Its game types are Preliminary,
Exhibition, Regular Season and Playoff, so a semifinal exports as a Playoff.

This is the cost of building to a written spec instead of to a real file from
the destination system, and it is why the golden file is now pinned to the
template rather than to our reading of it.

## Speed

The only slow thing in the app was the schedule generator, and it was slow for
a reason worth recording: it was told to try 120,000 local-search proposals
and it did.

Measured on the real House season, every quality measure is **identical** at
5,000 iterations and at 240,000 — longest repeat run, back-to-back rematches,
same-opponent-two-weeks-apart, spread of late games, and the validator's own
warning count. The search finds its answer in the first few thousand proposals
and spends the next eight seconds confirming it, with the browser frozen.

| iterations | time | longest repeat run | back-to-back | late-game spread |
|---|---|---|---|---|
| 5,000 | 0.4 s | 2 | 2 | 0 |
| 30,000 | 2.0 s | 2 | 2 | 0 |
| 120,000 | 8.3 s | 2 | 2 | 0 |
| 240,000 | 17.1 s | 2 | 2 | 0 |

So the search now stops when it stops improving: `stallLimit` proposals
without beating the best schedule found and it gives up, with `iterations`
left as a cap for a season that genuinely needs more. **8.3 s → 0.78 s**, same
output quality, and the report says how many proposals it actually ran and
whether it settled or ran out of budget.

Nothing else is close. On the same season: `validateSeason` 3.5 ms,
`readiness` 2.3 ms, `assignPractices` 1.2 ms, `generatePlayoffs` 1.2 ms,
`standings` and `resolveBracket` 0.1 ms each — and those are the ones that run
on every keystroke.

### The weekly rule, soft

`maxGamesPerWeek` was 1 and Tom's own 2026-27 schedule has 39 team-weeks with
two games in them. The generator treated the manifest as hard, so it could not
reproduce a schedule the league actually ran and left eleven fixtures with
nowhere to go. Raising the cap to 2 fixed that and created worse problems:
measured, it produced **47** double weeks against his 39, loaded them into
**December** instead of February, and took back-to-back days from 2 to 44.

So the rule is now two numbers. `maxGamesPerWeek` is a ceiling nothing may
cross; `softGamesPerWeek` is the point at which a week starts costing. House
is 1 soft, 2 hard. A league that wants the old behaviour sets them equal, which
is what Adult and Middle School do.

Three things shape where the doubles land, because a penalty on its own just
moves the problem:

1. **Price by date.** A second game costs `(1 − through)²` of full price, so
   February is cheap and November is not. A double late is a team catching up;
   the same double early is crowding.
2. **The week quota rounds down, not up.** It used to round up, which gave the
   *first* weeks the extra game — the one place a double is least welcome. The
   remainder now goes to the last weeks.
3. **Back-to-back days are priced too.** Loosening the week without this is
   what turns a second game into the very next morning, since a weekend-heavy
   rink has Saturday and Sunday ice and little else.

Plus a fairness term on the spread of doubles per team, so they do not all land
on one unlucky squad.

Measured on the real season, against the schedule Tom actually ran:

| | his schedule | hard 1 (before) | soft 1 / max 2 |
|---|---|---|---|
| Double weeks | 39 | 0 | **22** |
| Worst-hit team | 5 | 0 | **3** |
| Back-to-back days | 40 | 0 | **22** |
| Games unplaced | — | 12 | **4** |
| Longest repeat run | — | 2 | **1** |

Fewer doubles than he runs by hand, spread more evenly, with fewer
back-to-back days and eleven more games placed.

It costs time. The cost function gained a weekly-load pass and a
consecutive-day scan, and the richer landscape gives the search more to find,
so it runs about 50,000 proposals instead of 10,000. Precomputing each
opening's rank, day, band and price — and sorting on integers rather than on
`"YYYY-MM-DDHH:MM"` strings — took the per-proposal cost down about threefold.
**Generate lands at roughly 2.2 s**, against 0.78 s for the hard rule and
8.3 s before any of this.

`OVER_WEEKLY_GAMES` fired 39 times on Tom's own schedule and now fires none:
those were never problems with the schedule, they were the manifest
disagreeing with the league. Total warnings on that season drop from 81 to 42.

## Size

Measured, because the answer to "will this cost me anything" should be a
number rather than a feeling.

| | raw | gzipped |
|---|---|---|
| Source in git | 405 KB | **116 KB** |
| What a visitor downloads | 205 KB | **58 KB** |

`package-lock.json` is 92 KB of the source total — a quarter of the repo — and
it stays, because without it an install is not reproducible.

The bundle was 84 KB gzipped until React was aliased to `preact/compat` in
`apps/web/vite.config.ts`. That is four lines of config, no source change, and
every end-to-end test passes either way; deleting those four lines puts React
back. React alone was 45 KB gzipped, more than half the old bundle.

Zod is the next largest piece at roughly 14 KB gzipped. It stays: parsing
untrusted files is exactly where this project's bugs have come from, and
hand-written validation to save 14 KB would be trading a real safeguard for
nothing that matters at this scale.

Against GitHub Pages' 1 GB site limit and roughly 100 GB monthly bandwidth,
58 KB a load is about 1.7 million visits a month before anything is at risk.

Playoffs added roughly 11 KB gzipped: the bracket model and resolver in core,
the backwards allocator in the engine, and the Playoffs view.

## Said once

Four things used to be written more than once. None cost meaningful size;
each was a chance for two copies to drift and give different answers.

1. **CSV writers** now live in `packages/io/src/exportCsv.ts`. The CLI and the
   console both call them, so the schedule file is the same file either way.
2. **Date formatting** is in `packages/core/src/time.ts` — `fmtDate`,
   `fmtDay`, `fmtLongDate` — used by the console, the public page and the CSVs
   alike. `apps/web/src/lib/fmt.ts` is gone.
3. **The generator's clash test** is one function, `blockers()`, answering the
   only question it ever asks: what stops these two teams playing in this
   slot? The greedy, the fill pass, the repair pass and the local search all
   call it. It previously existed in four slightly different shapes.
4. **"Is this a playoff game"** is `PLAYOFF_TYPES` in
   `packages/core/src/schema.ts`. The standings, the validator and the engine
   each held their own copy of the set, which is three places to forget when
   `quarterfinal` was added — and adding it is exactly what surfaced them.

Collapsing them changed no output: the same seed on the same season produces a
byte-identical schedule, which is the point of a seeded generator.

## Getting a season into the console

The console could originally only *open* a season file, which meant it was
unusable to anyone who did not already have one — the importers existed only
as CLI tools behind Node. That was a real gap, and the fix is that every
importer in `packages/io` now has a path through the UI:

- the opening screen offers **Open a season file** or **Start a new season**;
- **Ice** imports a Finnly CSV, and adds or removes a slot by hand;
- **Teams** imports a team list and creates the divisions it finds, and adds
  or removes a team by hand;
- **Setup** holds the season's dates, divisions, targets and blackout dates,
  and imports a blackout CSV.

An end-to-end test drives the whole path with no season file at all: create,
import ice, add a slot by hand, import teams, set a target, generate.

## Still to build

0. Best-of-three series. Every bracket game is one game; a series needs a node
   that resolves on aggregate rather than on a single result, which the
   `SeedSource` shape can carry but the resolver does not read yet.
1. A Python OR-Tools CP-SAT verifier reading the same season JSON, to answer
   whether a schedule is provably optimal or how far from it.
3. Family constraints in the *generator*. The validator already reports
   household overload; the scheduler does not yet avoid creating it.
4. Jersey number assignment as min-cost flow, exposing the trade-off between
   maximizing first choices and minimizing families who get nothing they asked
   for. On the 2026-27 data those differ by 24 families.
5. The UI.
