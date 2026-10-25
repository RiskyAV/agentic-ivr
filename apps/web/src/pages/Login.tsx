import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Loader2, LockKeyhole, ShieldCheck } from 'lucide-react';
import { api, ApiError, type DemoCustomer } from '../api';
import { Wordmark } from '../components/Brand';
import type { StoredSession } from '../session';

const initials = (name: string) => name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
const TINTS = ['bg-teal-50 text-teal-700', 'bg-sky-50 text-sky-700', 'bg-amber-50 text-amber-700', 'bg-violet-50 text-violet-700'];

export function Login({ onSignedIn }: { onSignedIn: (s: StoredSession) => void }) {
  const [customers, setCustomers] = useState<DemoCustomer[] | null>(null);
  const [needsCode, setNeedsCode] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [otp, setOtp] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api.demoCustomers().then(
        (r) => { if (alive) { setCustomers(r.customers); setNeedsCode(r.requiresAccessCode); setLoadError(null); } },
        (e: unknown) => { if (alive) { setLoadError(e instanceof Error ? e.message : 'Could not load.'); setTimeout(load, 2000); } },
      );
    void load();
    return () => { alive = false; };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!selected) return setError('Choose a customer to continue.');
    if (!/^\d{6}$/.test(otp)) return setError('Enter the 6-digit one-time password.');
    if (needsCode && !code.trim()) return setError('Enter the demo access code.');
    setBusy(true);
    try {
      const r = await api.login(selected, otp, needsCode ? code.trim() : undefined);
      const c = customers?.find((x) => x.id === selected);
      onSignedIn({ token: r.token, customerId: selected, name: c?.name ?? '' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError(needsCode ? 'That code or access code is not right. Please check and try again.' : 'That code is not right. Please check and try again.');
      else setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full bg-canvas">
      <div className="bg-navy-900 pb-40 pt-6">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5">
          <Wordmark />
          <span className="hidden items-center gap-1.5 text-xs text-navy-300 sm:flex"><ShieldCheck className="h-4 w-4" /> Secure sign-in</span>
        </div>
        <div className="mx-auto mt-10 max-w-3xl px-5">
          <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Your loan, answered.</h1>
          <p className="mt-2 max-w-xl text-sm text-navy-300 sm:text-base">Ask about your EMI, payments, prepayment or foreclosure — and act on it, with every figure taken from your account.</p>
        </div>
      </div>

      <form onSubmit={submit} className="mx-auto -mt-28 max-w-3xl px-4 pb-12 sm:px-5">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_12px_40px_-12px_rgba(11,31,58,0.25)] sm:p-8">
          <h2 className="text-base font-semibold text-slate-900">Sign in</h2>
          <p className="mt-1 text-sm text-slate-500">Choose a demo customer. All data is synthetic.</p>

          <fieldset className="mt-5">
            <legend className="sr-only">Demo customer</legend>
            {!customers && !loadError && (
              <div className="grid gap-3 sm:grid-cols-2">
                {[0, 1, 2, 3].map((i) => <div key={i} className="h-[92px] animate-pulse rounded-xl bg-slate-100" />)}
              </div>
            )}
            {loadError && !customers && <p className="text-sm text-red-600">{loadError} Retrying…</p>}
            {customers && (
              <div className="grid gap-3 sm:grid-cols-2">
                {customers.map((c, i) => {
                  const on = selected === c.id;
                  return (
                    <label
                      key={c.id}
                      className={`group relative flex cursor-pointer gap-3 rounded-xl border p-4 transition focus-within:ring-2 focus-within:ring-teal-500 focus-within:ring-offset-2 ${on ? 'border-teal-500 bg-teal-50/40 ring-1 ring-teal-500' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'}`}
                    >
                      <input type="radio" name="customer" value={c.id} checked={on} onChange={() => { setSelected(c.id); setError(null); }} className="sr-only" />
                      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${TINTS[i % TINTS.length]}`}>{initials(c.name)}</span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-slate-900">{c.name}</span>
                        <span className="mt-0.5 block text-[13px] leading-snug text-slate-500">{c.story}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>

          <div className={`mt-6 grid gap-4 ${needsCode ? 'sm:grid-cols-2' : 'sm:max-w-xs'}`}>
            <div>
              <label htmlFor="otp" className="text-sm font-medium text-slate-700">One-time password</label>
              <input
                id="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp}
                onChange={(e) => { setOtp(e.target.value.replace(/\D/g, '')); setError(null); }}
                placeholder="6-digit code"
                className={`tnum mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base text-slate-900 outline-none placeholder:text-slate-400 ${otp ? 'tracking-[0.3em]' : ''} focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20`}
              />
              <p className="mt-1.5 text-xs text-slate-500">Use <span className="tnum font-medium text-slate-700">123456</span> for this demo.</p>
            </div>
            {needsCode && (
              <div>
                <label htmlFor="code" className="text-sm font-medium text-slate-700">Demo access code</label>
                <input
                  id="code" type="password" value={code} onChange={(e) => { setCode(e.target.value); setError(null); }}
                  className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-base text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20"
                />
                <p className="mt-1.5 text-xs text-slate-500">Shared with you alongside the demo link.</p>
              </div>
            )}
          </div>

          {error && <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          <div className="mt-6 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-1.5 text-xs text-slate-500"><LockKeyhole className="h-3.5 w-3.5" /> Your session is signed and bound to this customer.</p>
            <button
              type="submit" disabled={busy}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-teal-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-700 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Continue <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
        <p className="mt-6 text-center text-xs text-slate-400">Northstar Finance is a fictional lender. Demo environment with synthetic data.</p>
      </form>
    </div>
  );
}
