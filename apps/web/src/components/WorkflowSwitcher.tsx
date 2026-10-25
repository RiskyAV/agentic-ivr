import type { WorkflowInfo } from '../api';

const OPTIONS = [
  { id: 'loan-servicing', label: 'Loan Servicing', short: 'Servicing' },
  { id: 'collections', label: 'Collections call', short: 'Collections' },
];

export function WorkflowSwitcher({ workflows, active, onChange, disabled }: {
  workflows: WorkflowInfo[] | null; active: string | undefined; onChange: (id: string) => void; disabled: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Workflow" className="flex rounded-lg bg-white/[0.07] p-0.5 ring-1 ring-white/10">
      {OPTIONS.map((o) => {
        const registered = workflows?.some((w) => w.id === o.id) ?? false;
        const on = active === o.id;
        const tip = registered ? undefined : `${o.label} isn't enabled on this server yet`;
        return (
          <span key={o.id} className="group relative">
            <button
              type="button" role="radio" aria-checked={on} disabled={!registered || disabled || on}
              onClick={() => onChange(o.id)} title={tip} data-workflow={o.id}
              className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-medium transition sm:px-3 ${on ? 'bg-white text-navy-900 shadow-sm' : registered ? 'text-navy-300 hover:text-white' : 'cursor-not-allowed text-navy-300/50'}`}
            >
              <span className="sm:hidden">{o.short}</span><span className="hidden sm:inline">{o.label}</span>
            </button>
            {tip && (
              <span role="tooltip" className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 hidden w-52 -translate-x-1/2 rounded-md bg-slate-900 px-2.5 py-1.5 text-center text-[11px] text-white shadow-lg group-hover:block">
                {tip}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}
