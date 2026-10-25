import type { TableView } from '@app/shared';

const looksNumeric = (v: string) => /^[-₹\d.,%\s]+$/.test(v.trim()) && /\d/.test(v);
const tone = (v: string) => (/^failed\b/i.test(v) ? 'text-amber-700 font-medium' : /^overdue\b/i.test(v) ? 'text-red-700 font-medium' : 'text-slate-700');

export function DataTable({ table: raw }: { table: TableView }) {
  // Columns that are empty in every row add width without information (e.g. "Reason" when nothing failed).
  const keep = raw.columns.map((_, ci) => raw.rows.length === 0 || raw.rows.some((r) => (r[ci] ?? '').trim() !== ''));
  const table = { ...raw, columns: raw.columns.filter((_, i) => keep[i]), rows: raw.rows.map((r) => r.filter((_, i) => keep[i])) };
  const numericCols = table.columns.map((_, ci) => table.rows.length > 0 && table.rows.every((r) => !r[ci] || looksNumeric(r[ci]!)));
  return (
    <figure className="mt-3 overflow-hidden rounded-xl border border-slate-200">
      <figcaption className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">{table.title}</figcaption>
      <div className="pane-scroll overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
              {table.columns.map((c, i) => <th key={i} className={`whitespace-nowrap px-3 py-2 font-medium ${numericCols[i] ? 'text-right' : ''}`}>{c}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {table.rows.map((r, ri) => (
              <tr key={ri} className="bg-white">
                {r.map((cell, ci) => (
                  <td key={ci} className={`px-3 py-2 align-top ${numericCols[ci] ? 'tnum whitespace-nowrap text-right' : cell.length > 24 ? 'min-w-[200px]' : 'whitespace-nowrap'} ${tone(cell)}`}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
