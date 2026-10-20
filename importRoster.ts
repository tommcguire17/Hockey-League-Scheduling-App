import { Person } from '@league/core';
import { parseCsv, Header } from './csv.js';
import { normalizeJerseyNumber, normalizeDate, slugify } from './normalize.js';
import type { ImportResult, ImportIssue } from './importIceSlots.js';

/**
 * Imports a registration or fitting-form export into Person records.
 *
 * Household linking is the point of this importer: two registrants sharing a
 * guardian email are the same household, which is what lets the scheduler
 * reason about families instead of teams.
 *
 * Deduplicates repeat submissions by keeping the LATEST timestamp per player.
 */
export function importRoster(csv: string): ImportResult<Person> {
  const rows = parseCsv(csv);
  const issues: ImportIssue[] = [];
  if (rows.length < 2) return { items: [], issues: [{ row: 0, message: 'File has no data rows.' }], skipped: 0 };

  const h = new Header(rows[0]!, 'Roster');
  const cLast = h.require('Player Last Name (PRINTED ON JERSEY)', 'Player Last Name', 'Last Name', 'Last');
  const cFirst = h.require('Player First Name', 'First Name', 'First');
  const cLevel = h.find('Level', 'Division', 'Program');
  const cTs = h.find('Timestamp', 'Submitted', 'Created');
  const cGuard = h.find('Parent/Guardian Name', 'Guardian Name', 'Parent Name');
  const cGEmail = h.find('Parent/Guardian E-Mail CONFIRM EMAIL', 'Parent/Guardian Email',
    'Guardian Email', 'Parent Email', 'Email Address');
  const cSize = h.find('JERSEY SIZE', 'Jersey Size', 'Size');
  const cSock = h.find('SOCKS', 'Sock Size', 'Socks');
  const cDob = h.find('Date of Birth', 'Birth Date', 'DOB');
  const cPref = [1, 2, 3].map((n) =>
    h.find(`NUMBER PREFERENCE #${n}`, `Number Preference ${n}`, `Number ${n}`, `Pref ${n}`));

  type Row = { person: Person; ts: string; line: number };
  const byPlayer = new Map<string, Row>();
  let skipped = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const last = (row[cLast] ?? '').trim();
    const first = (row[cFirst] ?? '').trim();
    if (!last || !first) {
      skipped++;
      issues.push({ row: r + 1, message: 'Missing player name; row skipped.' });
      continue;
    }
    const ts = cTs >= 0 ? (row[cTs] ?? '').trim() : '';
    const levelRaw = cLevel >= 0 ? (row[cLevel] ?? '').trim() : '';
    const divisionId = levelRaw ? (/^(u\d+|\d+u)/i.exec(levelRaw)?.[0] ?? levelRaw).toLowerCase() : null;

    const prefs: number[] = [];
    for (const c of cPref) {
      if (c < 0) continue;
      const n = normalizeJerseyNumber(row[c]);
      const rawText = (row[c] ?? '').trim();
      if (n === null && rawText) {
        issues.push({ row: r + 1, message: `${first} ${last}: "${rawText}" is not a usable number (1-98).` });
      }
      if (n !== null) prefs.push(n);
    }

    const guardianEmail = (cGEmail >= 0 ? (row[cGEmail] ?? '') : '').trim().toLowerCase();
    const person = Person.parse({
      id: `p-${slugify(last)}-${slugify(first)}`,
      firstName: titleCase(first),
      lastName: last.toUpperCase(),
      divisionId,
      teamId: null,
      birthDate: cDob >= 0 ? normalizeDate(row[cDob] ?? '') : null,
      // Household = shared guardian email. Replace with the Finnly household id
      // as soon as that export is available; this is the best proxy we have.
      householdId: guardianEmail ? `hh-${slugify(guardianEmail)}` : null,
      guardianName: (cGuard >= 0 ? (row[cGuard] ?? '') : '').trim(),
      guardianEmail,
      jerseyNumber: null,
      jerseySize: (cSize >= 0 ? (row[cSize] ?? '') : '').trim(),
      sockSize: (cSock >= 0 ? (row[cSock] ?? '') : '').trim(),
      numberPrefs: prefs,
      registeredAt: ts,
    });

    const key = person.id;
    const prev = byPlayer.get(key);
    if (prev) {
      issues.push({
        row: r + 1,
        message: `${person.firstName} ${person.lastName} submitted more than once; keeping the later entry.`,
      });
      if (ts >= prev.ts) byPlayer.set(key, { person, ts, line: r + 1 });
    } else {
      byPlayer.set(key, { person, ts, line: r + 1 });
    }
  }

  const items = [...byPlayer.values()]
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .map((x) => x.person);
  return { items, issues, skipped };
}

const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());

/** Households with more than one registrant. These drive family constraints. */
export function householdsOf(people: Person[]): Map<string, Person[]> {
  const m = new Map<string, Person[]>();
  for (const p of people) {
    if (!p.householdId) continue;
    (m.get(p.householdId) ?? m.set(p.householdId, []).get(p.householdId)!).push(p);
  }
  for (const [k, v] of m) if (v.length < 2) m.delete(k);
  return m;
}
