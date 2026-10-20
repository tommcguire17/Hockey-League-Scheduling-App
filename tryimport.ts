import { readFileSync } from 'node:fs';
import { importIceSlots, importRoster, householdsOf } from '@league/io';

const ice = importIceSlots(readFileSync(process.argv[2]!, 'utf8'), { defaultUse: 'game' });
console.log(`ICE: ${ice.items.length} slots, ${ice.skipped} skipped, ${ice.issues.length} issues`);
const rinks = new Map<string, number>();
for (const s of ice.items) rinks.set(s.rink, (rinks.get(s.rink) ?? 0) + 1);
console.log('  rinks after normalization:', [...rinks].map(([k, v]) => `${k}=${v}`).join('  '));
console.log(`  date range ${ice.items[0]?.date} .. ${ice.items.at(-1)?.date}`);
const mins = new Map<number, number>();
for (const s of ice.items) mins.set(s.minutes, (mins.get(s.minutes) ?? 0) + 1);
console.log('  slot lengths:', [...mins].sort((a,b)=>a[0]-b[0]).map(([k,v])=>`${k}min x${v}`).join('  '));
for (const i of ice.issues.slice(0, 3)) console.log('  issue:', i.message);

const ros = importRoster(readFileSync(process.argv[3]!, 'utf8'));
console.log(`\nROSTER: ${ros.items.length} players, ${ros.skipped} skipped, ${ros.issues.length} issues`);
const div = new Map<string, number>();
for (const p of ros.items) div.set(p.divisionId ?? '?', (div.get(p.divisionId ?? '?') ?? 0) + 1);
console.log('  by division:', [...div].sort().map(([k, v]) => `${k}=${v}`).join('  '));
const noPref = ros.items.filter((p) => p.numberPrefs.length === 0).length;
console.log(`  players with no usable number preference: ${noPref}`);
for (const i of ros.issues.slice(0, 6)) console.log('  issue:', i.message);
if (ros.issues.length > 6) console.log(`  ...and ${ros.issues.length - 6} more issues`);

const hh = householdsOf(ros.items);
const sizes = [...hh.values()].map((v) => v.length);
console.log(`\nHOUSEHOLDS with more than one registrant: ${hh.size}`);
console.log(`  siblings covered: ${sizes.reduce((a, b) => a + b, 0)} players`);
let crossDiv = 0;
for (const v of hh.values()) if (new Set(v.map((p) => p.divisionId)).size > 1) crossDiv++;
console.log(`  households spanning MORE THAN ONE division: ${crossDiv}`);
console.log('  examples:');
for (const v of [...hh.values()].filter((v) => new Set(v.map((p) => p.divisionId)).size > 1).slice(0, 4)) {
  console.log(`    ${v.map((p) => `${p.firstName} ${p.lastName} (${p.divisionId})`).join('  +  ')}`);
}
