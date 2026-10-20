/** CLI: npx tsx tools/js/generate.ts <season.json> [seed] */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadSeason, saveSeason } from '@league/io';
import { generateSchedule } from '@league/engine';
import { manifestFor, validateSeason, summarize, weekKey } from '@league/core';

const path = process.argv[2]!;
const seed = Number(process.argv[3] ?? 20262027);
const season = loadSeason(readFileSync(path, 'utf8'));
const m = manifestFor(season.leagueId);

const t0 = Date.now();
const { games, report } = generateSchedule(season, m, { seed });
const ms = Date.now() - t0;

const out = { ...season, games };
writeFileSync(path, saveSeason(out));

console.log(`${season.name}  [${m.name}]  seed ${report.seed}  ${ms}ms`);
for (const d of report.byDivision) {
  console.log(`  ${d.divisionId}: ${d.teams} teams x ${d.gamesPerTeam} games = ` +
    `${d.fixtures} fixtures, ${d.placed} placed`);
}
if (report.unplaced.length) {
  console.log(`\n  ${report.unplaced.length} UNPLACED:`);
  for (const u of report.unplaced.slice(0, 10)) console.log(`    ${u.homeId} v ${u.awayId} — ${u.reason}`);
}

const r = validateSeason(out, m);
console.log(`\nvalidation: ${r.errorCount} errors, ${r.warningCount} warnings`);
for (const s of summarize(r)) console.log(`  ${s.severity.toUpperCase().padEnd(8)} ${s.code.padEnd(26)} ${s.count}`);

const slot = new Map(out.slots.map((s) => [s.id, s]));
console.log('\nTEAM                 DIV    GP  HOME AWAY  WEEKS  RUN  OPPONENTS');
for (const t of r.teams) {
  const gs = games.filter((g) => g.homeTeamId === t.teamId || g.awayTeamId === t.teamId);
  const home = gs.filter((g) => g.homeTeamId === t.teamId).length;
  const wks = new Set(gs.map((g) => weekKey(slot.get(g.slotId!)!.date, m.week.startsOn)));
  console.log(`  ${t.teamName.slice(0, 19).padEnd(19)} ${t.divisionId.padEnd(6)}` +
    `${String(t.games).padStart(3)}${String(home).padStart(6)}${String(gs.length - home).padStart(5)}` +
    `${String(wks.size).padStart(7)}${String(t.longestRepeatRun).padStart(5)}  ${t.opponents.length}`);
}
