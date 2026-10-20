/** CLI: npx tsx tools/js/validate.ts data/<file>.season.json */
import { readFileSync } from 'node:fs';
import { loadSeason } from '@league/io';
import { validateSeason, manifestFor, summarize } from '@league/core';

const path = process.argv[2];
if (!path) { console.error('usage: validate <season.json>'); process.exit(2); }
const season = loadSeason(readFileSync(path, 'utf8'));
const manifest = manifestFor(season.leagueId);
const r = validateSeason(season, manifest);

console.log(`${season.name}  [${manifest.name}]`);
console.log(`  ${season.teams.length} teams, ${season.slots.length} slots, ` +
  `${season.games.length} games, ${season.practices.length} practice groups`);
console.log(`  ${r.errorCount} errors, ${r.warningCount} warnings\n`);
console.log('TEAM                GAMES  PRAC   EVAL  MORN MID EVE  RUN');
for (const t of r.teams) {
  console.log(
    `  ${t.teamName.padEnd(16)} ${String(t.games).padStart(3)}/${String(t.gamesTarget).padEnd(3)}` +
    ` ${String(t.practices).padStart(3)}/${String(t.practicesTarget).padEnd(3)}` +
    ` ${String(t.evaluations).padStart(4)}  ${String(t.bands.morning).padStart(4)}${String(t.bands.midday).padStart(4)}` +
    `${String(t.bands.evening).padStart(4)}  ${t.longestRepeatRun}`);
}
console.log('\nVIOLATIONS BY CODE');
for (const s of summarize(r)) console.log(`  ${s.severity.toUpperCase().padEnd(8)} ${s.code.padEnd(28)} ${s.count}`);
const errs = r.violations.filter((v) => v.severity === 'error');
if (errs.length) {
  console.log('\nERRORS');
  for (const e of errs.slice(0, 25)) console.log(`  ${e.code}: ${e.message}`);
  if (errs.length > 25) console.log(`  ...and ${errs.length - 25} more`);
}
