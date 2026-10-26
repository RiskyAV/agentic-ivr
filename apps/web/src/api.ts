import type { SystemName } from '@app/shared';
import type { ChaosConfig, SystemChaos } from './store';

/** '' in dev (Vite proxies /api and /ws); an absolute origin in production builds. */
export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');

export const SYSTEMS: SystemName[] = ['crm', 'lms', 'payments', 'policy', 'ops'];

/** The signed-in session's token, sent on calls that need it when the server is gated (chaos changes). */
let authToken: string | undefined;
export function setApiToken(token: string | undefined): void { authToken = token; }

/** The shared demo password, set as a readable cookie by the edge gate on the HTML response (absent in local dev). */
export function accessCodeFromCookie(): string | undefined {
  try {
    const m = /(?:^|;\s*)demo_access=([^;]*)/.exec(document.cookie);
    return m?.[1] ? decodeURIComponent(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

async function call<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers: Record<string, string> = { ...(init.body ? { 'content-type': 'application/json' } : {}) };
  const access = accessCodeFromCookie();
  if (access) headers['x-access-code'] = access;
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(API_BASE + path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
  } catch {
    throw new ApiError(0, 'network', 'We could not reach Northstar right now. Check your connection and try again.');
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const code = typeof body.error === 'string' ? body.error : 'http_error';
    const message = typeof body.message === 'string' ? body.message : `Request failed (${res.status}).`;
    throw new ApiError(res.status, code, message);
  }
  return body as T;
}

export interface DemoCustomer { id: string; name: string; story: string }
export interface WorkflowInfo { id: string; name: string; description: string; suggestions: string[] }
export interface MetricStat { p50: number; p95: number; n: number }
export interface MetricsResponse { metrics: Record<string, MetricStat>; sessions: number; eventLoopLagP99: number; rssMb: number }

export const api = {
  demoCustomers: () => call<{ customers: DemoCustomer[]; requiresAccessCode: boolean }>('/api/demo-customers'),
  login: (customerId: string, otp: string, accessCode?: string) =>
    call<{ token: string; sessionId: string }>('/api/login', {
      method: 'POST', body: JSON.stringify({ customerId, otp, ...(accessCode ? { accessCode } : {}) }),
    }),
  workflows: () => call<{ workflows: WorkflowInfo[] }>('/api/workflows'),
  metrics: () => call<MetricsResponse>('/api/metrics'),
  /** 401 means the token is no longer valid. */
  checkToken: (token: string) => call<unknown>('/api/me/snapshot', {}, token),
  chaos: async (): Promise<ChaosConfig> => normaliseChaos(await call<Record<string, Partial<SystemChaos>>>('/api/chaos')),
  setChaos: async (c: ChaosConfig): Promise<ChaosConfig> =>
    normaliseChaos(await call<Record<string, Partial<SystemChaos>>>('/api/chaos', { method: 'PUT', body: JSON.stringify(c) }, authToken)),
  resetChaos: () => call<{ ok: boolean }>('/api/chaos/reset', { method: 'POST' }, authToken),
};

/** The mock returns effective profiles (with base latency fields); keep only what the controls edit. */
function normaliseChaos(raw: Record<string, Partial<SystemChaos>>): ChaosConfig {
  const out = {} as ChaosConfig;
  for (const s of SYSTEMS) {
    const r = raw[s] ?? {};
    out[s] = { extraLatencyMs: Number(r.extraLatencyMs ?? 0), failRate: Number(r.failRate ?? 0), hang: Boolean(r.hang) };
  }
  return out;
}

export function wsUrl(token: string): string {
  const base = API_BASE || window.location.origin;
  const u = new URL('/ws', base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.searchParams.set('token', token);
  return u.toString();
}
