import { create } from 'zustand';
import type { Channel, ChatItemView, ProposalView, ServerMsg, SnapshotView, Source, SystemName, TableView, TurnTrace } from '@app/shared';

export type ProposalStatus = 'pending' | 'confirming' | 'executed' | 'rejected' | 'failed' | 'expired';

export type ChatItem =
  | { kind: 'user'; id: string; turnId: string; text: string; channel: Channel }
  | {
      kind: 'assistant'; id: string; turnId: string; text: string; sources: Source[]; tables?: TableView[];
      streaming: boolean; retracted?: boolean;
    }
  | { kind: 'proposal'; id: string; proposal: ProposalView; status: ProposalStatus; reference?: string; message?: string }
  | { kind: 'notice'; id: string; text: string; tone: 'success' | 'info' | 'error' };

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SystemChaos { extraLatencyMs: number; failRate: number; hang: boolean }
export type ChaosConfig = Record<SystemName, SystemChaos>;

export interface AppState {
  connection: ConnectionState;
  session: { sessionId: string; workflowId: string; customer: { id: string; name: string } } | null;
  snapshot: SnapshotView | null;
  items: ChatItem[];
  /** Ids of proposals still awaiting the customer's decision. */
  pendingProposals: string[];
  /** Newest first, capped. */
  traces: TurnTrace[];
  activeTurn: { turnId: string; progress?: string } | null;
  voice: { state: 'off' | 'listening' | 'thinking' | 'speaking'; caption: string };
  chaos: ChaosConfig | null;
  notice: { code: string; message: string; at: number } | null;
}

const MAX_TRACES = 20;

export const initialState = (): AppState => ({
  connection: 'idle', session: null, snapshot: null, items: [], pendingProposals: [], traces: [], activeTurn: null,
  voice: { state: 'off', caption: '' }, chaos: null, notice: null,
});

const assistantId = (turnId: string) => `a:${turnId}`;
const userId = (turnId: string) => `u:${turnId}`;
const proposalId = (id: string) => `p:${id}`;

function fromHistory(v: ChatItemView, i: number): ChatItem {
  switch (v.kind) {
    case 'user': return { kind: 'user', id: userId(v.turnId), turnId: v.turnId, text: v.text, channel: v.channel };
    case 'assistant':
      return { kind: 'assistant', id: `${assistantId(v.turnId)}:${i}`, turnId: v.turnId, text: v.text, sources: v.sources, ...(v.tables && { tables: v.tables }), streaming: false };
    case 'proposal': return { kind: 'proposal', id: proposalId(v.proposal.id), proposal: v.proposal, status: v.status };
    case 'action_result':
      return { kind: 'notice', id: `r:${v.proposalId}:${i}`, text: v.reference ? `${v.message} Reference ${v.reference}.` : v.message, tone: v.status === 'executed' ? 'success' : 'info' };
  }
}

/** Ends the streaming state of the turn's assistant message, if any. */
function endTurn(s: AppState, turnId: string): AppState {
  const items = s.items.map((i) => (i.kind === 'assistant' && i.turnId === turnId && i.streaming ? { ...i, streaming: false } : i));
  return { ...s, items, activeTurn: s.activeTurn?.turnId === turnId ? null : s.activeTurn };
}

function upsertAssistant(s: AppState, turnId: string, f: (a: Extract<ChatItem, { kind: 'assistant' }> | undefined) => Extract<ChatItem, { kind: 'assistant' }>): AppState {
  const id = assistantId(turnId);
  const idx = s.items.findIndex((i) => i.id === id);
  if (idx < 0) return { ...s, items: [...s.items, f(undefined)] };
  const items = s.items.slice();
  items[idx] = f(items[idx] as Extract<ChatItem, { kind: 'assistant' }>);
  return { ...s, items };
}

function setProposal(s: AppState, id: string, patch: (p: Extract<ChatItem, { kind: 'proposal' }>) => Partial<Extract<ChatItem, { kind: 'proposal' }>> | null): AppState {
  const key = proposalId(id);
  let changed = false;
  const items = s.items.map((i) => {
    if (i.kind !== 'proposal' || i.id !== key) return i;
    const p = patch(i);
    if (!p) return i;
    changed = true;
    return { ...i, ...p };
  });
  return changed ? { ...s, items } : s;
}

const isFinal = (st: ProposalStatus) => st === 'executed' || st === 'rejected' || st === 'failed' || st === 'expired';

/** Pure reducer over server messages. */
export function reduce(s: AppState, m: ServerMsg): AppState {
  switch (m.type) {
    case 'session_ready': {
      const session = { sessionId: m.sessionId, workflowId: m.workflowId, customer: m.customer };
      if (!m.resumed) return { ...s, session, items: [], pendingProposals: [], activeTurn: null };
      const pendingProposals = m.history.flatMap((h) => (h.kind === 'proposal' && h.status === 'pending' ? [h.proposal.id] : []));
      // Reconnect within the same tab: the local transcript is a superset of the server's text-only history
      // (it has sources, tables and executed cards), and a turn cut by the drop was aborted server-side.
      if (s.session?.sessionId === m.sessionId && s.items.length > 0) {
        const items = s.items.map((i) => (i.kind === 'assistant' && i.streaming ? { ...i, streaming: false } : i));
        const known = new Set(items.map((i) => i.id));
        const missing = m.history.map(fromHistory).filter((i) => i.kind === 'proposal' && !known.has(i.id));
        return { ...s, session, items: [...items, ...missing], pendingProposals, activeTurn: null };
      }
      const items = m.history.map(fromHistory);
      return { ...s, session, items, pendingProposals, activeTurn: null };
    }
    case 'snapshot':
      return { ...s, snapshot: m.snapshot };
    case 'turn_start': {
      const exists = s.items.some((i) => i.kind === 'user' && i.turnId === m.turnId);
      const items: ChatItem[] = exists ? s.items : [...s.items, { kind: 'user', id: userId(m.turnId), turnId: m.turnId, text: m.userText, channel: m.channel }];
      return { ...s, items, activeTurn: { turnId: m.turnId } };
    }
    case 'progress':
      return s.activeTurn?.turnId === m.turnId ? { ...s, activeTurn: { turnId: m.turnId, progress: m.label } } : s;
    case 'assistant_delta':
      return upsertAssistant(s, m.turnId, (a) =>
        a ? { ...a, text: a.retracted ? a.text : a.text + m.text } : { kind: 'assistant', id: assistantId(m.turnId), turnId: m.turnId, text: m.text, sources: [], streaming: true },
      );
    case 'assistant_done': {
      const next = upsertAssistant(s, m.turnId, (a) => {
        if (a?.retracted) return { ...a, streaming: false };
        const base = a ?? { kind: 'assistant' as const, id: assistantId(m.turnId), turnId: m.turnId, text: '', sources: [], streaming: false };
        const { tables: _t, ...rest } = base;
        return { ...rest, text: m.text, sources: m.sources, ...(m.tables && m.tables.length > 0 && { tables: m.tables }), streaming: false };
      });
      return endTurn(next, m.turnId);
    }
    case 'assistant_retract':
      return upsertAssistant(s, m.turnId, (a) => {
        const base = a ?? { kind: 'assistant' as const, id: assistantId(m.turnId), turnId: m.turnId, text: '', sources: [], streaming: false };
        const { tables: _t, ...rest } = base;
        return { ...rest, text: m.replacement, sources: [], retracted: true };
      });
    case 'action_proposal': {
      const key = proposalId(m.proposal.id);
      if (s.items.some((i) => i.id === key)) return s;
      return {
        ...s,
        items: [...s.items, { kind: 'proposal', id: key, proposal: m.proposal, status: 'pending' }],
        pendingProposals: [...s.pendingProposals, m.proposal.id],
      };
    }
    case 'action_result': {
      // An executed card never goes back (e.g. a late "already completed" reply to a cancel).
      const next = setProposal(s, m.proposalId, (p) =>
        p.status === 'executed' && m.status !== 'executed' ? null : { status: m.status, message: m.message, ...(m.reference && { reference: m.reference }) });
      // A failed but retryable execution leaves the proposal pending on the server; keep it confirmable.
      const stillPending = m.status === 'failed' && m.retryable === true;
      const patched = stillPending ? setProposal(next, m.proposalId, (p) => ({ status: 'pending', message: p.message ?? m.message })) : next;
      return { ...patched, pendingProposals: stillPending ? patched.pendingProposals : patched.pendingProposals.filter((id) => id !== m.proposalId) };
    }
    case 'trace': {
      const traces = [m.trace, ...s.traces.filter((t) => t.turnId !== m.trace.turnId)].slice(0, MAX_TRACES);
      return endTurn({ ...s, traces }, m.trace.turnId);
    }
    case 'error': {
      const notice = { code: m.code, message: m.message, at: Date.now() };
      // Errors that arrive while a turn runs mean no answer is coming.
      const ended = s.activeTurn && m.code !== 'voice_unavailable' ? endTurn(s, s.activeTurn.turnId) : s;
      return { ...ended, notice };
    }
    case 'transcript':
      return { ...s, voice: { ...s.voice, caption: m.text } };
    case 'tts_begin':
      return { ...s, voice: { ...s.voice, state: 'speaking' } };
    case 'tts_end':
      return { ...s, voice: { ...s.voice, state: s.voice.state === 'speaking' ? 'listening' : s.voice.state } };
    case 'barge_in':
      return { ...s, voice: { ...s.voice, state: 'listening' } };
    default:
      return s;
  }
}

/** The customer's own message, shown before the server echoes turn_start. */
export function localUserText(s: AppState, turnId: string, text: string): AppState {
  return { ...s, items: [...s.items, { kind: 'user', id: userId(turnId), turnId, text, channel: 'text' }], activeTurn: { turnId } };
}

export function localConfirming(s: AppState, id: string): AppState {
  return setProposal(s, id, (p) => (p.status === 'pending' ? { status: 'confirming' } : null));
}

/** Client-side expiry when the countdown reaches zero; the server stays the authority on confirm. */
export function localExpire(s: AppState, id: string): AppState {
  const next = setProposal(s, id, (p) => (isFinal(p.status) ? null : { status: 'expired' }));
  return { ...next, pendingProposals: next.pendingProposals.filter((x) => x !== id) };
}

/** The server sends no acknowledgement for set_workflow; the switch is reflected locally. */
export function localWorkflow(s: AppState, workflowId: string): AppState {
  return s.session ? { ...s, session: { ...s.session, workflowId } } : s;
}

interface Actions {
  apply(m: ServerMsg): void;
  setWorkflow(id: string): void;
  userText(turnId: string, text: string): void;
  confirming(id: string): void;
  expire(id: string): void;
  setConnection(c: ConnectionState): void;
  setChaos(c: ChaosConfig | null): void;
  clearNotice(): void;
  reset(): void;
}

export const useStore = create<AppState & Actions>()((set) => ({
  ...initialState(),
  apply: (m) => set((s) => reduce(s, m)),
  setWorkflow: (id) => set((s) => localWorkflow(s, id)),
  userText: (turnId, text) => set((s) => localUserText(s, turnId, text)),
  confirming: (id) => set((s) => localConfirming(s, id)),
  expire: (id) => set((s) => localExpire(s, id)),
  setConnection: (connection) => set({ connection }),
  setChaos: (chaos) => set({ chaos }),
  clearNotice: () => set({ notice: null }),
  reset: () => set(initialState()),
}));
