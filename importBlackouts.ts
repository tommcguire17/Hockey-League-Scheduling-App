import { parseCsv, Header } from './csv.js';
import { normalizeDate } from './normalize.js';
import type { ImportIssue } from './importIceSlots.js';

export interface BlackoutImport {
  dates: string[];
  reasons: Map<string, string>;
  issues: ImportIssue[];
}

/**
 * League-wide no-play dates. Columns: Date | Reason (Reason optional).
 * Blank lines and lines starting with # are ignored, so the template can
 * carry commented-out examples.
 */
export function importBlackouts(csv: string): BlackoutImport {
  const rows = parseCsv(csv).filter((r) => !String(r[0] ?? '').trim().startsWith('#'));
  const issues: ImportIssue[] = [];
  if (rows.length < 1) return { dates: [], reasons: new Map(), issues };

  const h = new Header(rows[0]!, 'Blackouts');
  const cDate = h.require('Date', 'Blackout Date', 'Day');
  const cWhy = h.find('Reason', 'Note', 'Why');

  const reasons = new Map<string, string>();
  for (let r = 1; r < rows.length; r++) {
    const raw = (rows[r]![cDate] ?? '').trim();
    if (!raw) continue;
    const d = normalizeDate(raw);
    if (!d) { issues.push({ row: r + 1, message: `"${raw}" is not a date I can read; row skipped.` }); continue; }
    if (reasons.has(d)) { issues.push({ row: r + 1, message: `${d} listed more than once.` }); continue; }
    reasons.set(d, cWhy >= 0 ? (rows[r]![cWhy] ?? '').trim() : '');
  }
  return { dates: [...reasons.keys()].sort(), reasons, issues };
}
