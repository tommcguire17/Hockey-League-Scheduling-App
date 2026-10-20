/** CLI: npx tsx tools/js/conflicts.ts data/a.season.json data/b.season.json ... */
import { readFileSync } from 'node:fs';
import { loadSeason } from '@league/io';
import { findIceConflicts } from '@league/core';

const seasons = process.argv.slice(2).map((p) => loadSeason(readFileSync(p, 'utf8')));
console.log(`Checking ${seasons.length} season(s) for shared ice:`);
for (const s of seasons) console.log(`  ${s.id} [${s.leagueId}] ${s.startDate} .. ${s.endDate}`);
const c = findIceConflicts(seasons);
if (!c.length) { console.log('\nNo sheet of ice is double-booked.'); process.exit(0); }
console.log(`\n${c.length} conflict(s):`);
for (const x of c) {
  console.log(`  ${x.date} ${x.start} ${x.rink}: ${x.booked} bookings in a slot holding ${x.capacity}`);
  for (const b of x.bySeason) console.log(`      ${b.leagueId} (${b.seasonId}) x${b.bookings}`);
}
process.exit(1);
