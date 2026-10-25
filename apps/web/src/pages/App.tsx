import { useEffect, useState } from 'react';
import { LogOut, PanelRightClose, PanelRightOpen, X } from 'lucide-react';
import { api, type WorkflowInfo } from '../api';
import { AccountPanel, AccountStrip } from '../components/AccountPanel';
import { BrandMark, Wordmark } from '../components/Brand';
import { Chat } from '../components/Chat';
import { Composer } from '../components/Composer';
import { ConnectionPill } from '../components/ConnectionPill';
import { TracePanel } from '../components/TracePanel';
import { WorkflowSwitcher } from '../components/WorkflowSwitcher';
import { useMediaQuery } from '../hooks';
import { socket } from '../socket';
import { useStore } from '../store';

const newTurnId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `t-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((p) => p[0]).join('').slice(0, 2).toUpperCase();

function Toast() {
  const notice = useStore((s) => s.notice);
  const clear = useStore((s) => s.clearNotice);
  useEffect(() => {
    if (!notice || notice.code === 'replaced') return;
    const t = setTimeout(clear, 6000);
    return () => clearTimeout(t);
  }, [notice, clear]);
  if (!notice || notice.code === 'voice_unavailable') return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-16 z-50 flex justify-center px-4">
      <div role="status" className="pointer-events-auto flex max-w-md items-start gap-3 rounded-xl bg-slate-900 px-4 py-3 text-sm text-white shadow-xl">
        <p>{notice.message}</p>
        <button type="button" onClick={clear} aria-label="Dismiss" className="text-slate-400 hover:text-white"><X className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

export function AppShell({ customerName, onLogout }: { customerName: string; onLogout: () => void }) {
  const session = useStore((s) => s.session);
  const snapshot = useStore((s) => s.snapshot);
  const connected = useStore((s) => s.connection === 'open');
  const userText = useStore((s) => s.userText);
  const setWorkflow = useStore((s) => s.setWorkflow);
  const [workflows, setWorkflows] = useState<WorkflowInfo[] | null>(null);
  const wide = useMediaQuery('(min-width: 1280px)');
  const tablet = useMediaQuery('(min-width: 768px)');
  const [traceOpen, setTraceOpen] = useState(wide);
  const [accountOpen, setAccountOpen] = useState(false);

  useEffect(() => { setTraceOpen(wide); }, [wide]);
  useEffect(() => {
    let alive = true;
    api.workflows().then((r) => { if (alive) setWorkflows(r.workflows); }, () => { if (alive) setWorkflows([]); });
    return () => { alive = false; };
  }, []);

  const name = session?.customer.name || customerName;
  const activeWf = workflows?.find((w) => w.id === session?.workflowId) ?? workflows?.[0];
  const send = (text: string) => {
    const turnId = newTurnId();
    if (!socket.send({ type: 'user_text', turnId, text })) return false;
    userText(turnId, text);
    return true;
  };
  const switchWorkflow = (id: string) => {
    if (socket.send({ type: 'set_workflow', workflowId: id })) setWorkflow(id);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="z-30 flex h-14 shrink-0 items-center gap-2 bg-navy-900 px-3 text-white shadow-[0_1px_0_rgba(255,255,255,0.06)] sm:gap-3 sm:px-5">
        <div className="hidden sm:block"><Wordmark /></div>
        <div className="sm:hidden"><BrandMark /></div>
        <div className="mx-auto sm:ml-6 lg:mx-auto">
          <WorkflowSwitcher workflows={workflows} active={session?.workflowId} onChange={switchWorkflow} disabled={!connected} />
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2.5">
          <ConnectionPill />
          <button
            type="button" onClick={() => setTraceOpen((v) => !v)} aria-pressed={traceOpen} data-testid="toggle-trace"
            className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition ${traceOpen ? 'bg-white/15 text-white' : 'text-navy-300 hover:bg-white/10 hover:text-white'}`}
            title="Under the hood"
          >
            {traceOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
            <span className="hidden xl:inline">Under the hood</span>
          </button>
          <div className="hidden h-6 w-px bg-white/15 sm:block" />
          <div className="flex items-center gap-2">
            <span className="hidden h-8 w-8 items-center justify-center rounded-full bg-teal-500/20 text-xs font-semibold text-teal-200 sm:flex">{initials(name)}</span>
            <span className="hidden text-sm font-medium md:inline" data-testid="customer-name">{name}</span>
          </div>
          <button type="button" onClick={onLogout} title="Sign out" aria-label="Sign out" className="rounded-lg p-1.5 text-navy-300 transition hover:bg-white/10 hover:text-white">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {tablet && (
          <aside className="pane-scroll w-[320px] shrink-0 overflow-y-auto border-r border-slate-200 bg-canvas" data-testid="account-panel">
            <AccountPanel snapshot={snapshot} />
          </aside>
        )}
        <main className="flex min-w-0 flex-1 flex-col bg-canvas">
          {!tablet && <AccountStrip snapshot={snapshot} onOpen={() => setAccountOpen(true)} />}
          <Chat suggestions={activeWf?.suggestions ?? []} onSend={send} />
          <Composer onSend={send} />
        </main>
        {wide && traceOpen && (
          <aside className="w-[380px] shrink-0 border-l border-slate-200" data-testid="trace-panel">
            <TracePanel />
          </aside>
        )}
      </div>

      {!wide && traceOpen && (
        <div className="fixed inset-0 z-40 flex justify-end" data-testid="trace-panel">
          <button type="button" aria-label="Close panel" className="absolute inset-0 bg-slate-900/30" onClick={() => setTraceOpen(false)} />
          <div className="relative h-full w-full max-w-[420px] shadow-2xl"><TracePanel onClose={() => setTraceOpen(false)} /></div>
        </div>
      )}
      {!tablet && accountOpen && (
        <div className="fixed inset-0 z-40 flex flex-col" data-testid="account-sheet">
          <button type="button" aria-label="Close" className="absolute inset-0 bg-slate-900/30" onClick={() => setAccountOpen(false)} />
          <div className="relative mt-auto max-h-[85%] overflow-y-auto rounded-t-2xl bg-canvas shadow-2xl">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
              <span className="text-sm font-semibold text-slate-900">Account</span>
              <button type="button" onClick={() => setAccountOpen(false)} aria-label="Close" className="rounded-md p-1 text-slate-500 hover:bg-slate-100"><X className="h-4 w-4" /></button>
            </div>
            <AccountPanel snapshot={snapshot} />
          </div>
        </div>
      )}
      <Toast />
    </div>
  );
}
