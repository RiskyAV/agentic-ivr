import type { Paise, PolicyTopic } from '@app/domain';
import type { SystemName } from '@app/shared';
import { DEFAULT_CLIENT_CONFIG, ResilientClient, type CallObserver, type ClientConfig, type Fetched } from './resilientClient.js';
import type { Transport } from './transport.js';
import type {
  CrmCustomer, Interaction, LoanRecordDto, OpsRequestDto, OpsRequestType, PaymentDto, PaymentLink, PolicyClauseDto, ScheduleRowDto,
} from './types.js';

export interface CallCtx {
  signal: AbortSignal;
  observer?: CallObserver;
}

function map<A, B>(p: Promise<Fetched<A>>, f: (a: A) => B): Promise<Fetched<B>> {
  return p.then((r) => (r.ok ? { ...r, data: f(r.data) } : r));
}

const qs = (q: Record<string, string | number | undefined>): string => {
  const parts = Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
};
const e = encodeURIComponent;

export interface Connectors {
  crm: {
    getCustomer(id: string, ctx: CallCtx): Promise<Fetched<CrmCustomer>>;
    getInteractions(id: string, ctx: CallCtx): Promise<Fetched<Interaction[]>>;
  };
  lms: {
    getLoans(customerId: string, ctx: CallCtx): Promise<Fetched<LoanRecordDto[]>>;
    getLoan(loanId: string, ctx: CallCtx): Promise<Fetched<LoanRecordDto>>;
    getSchedule(loanId: string, q: { from?: string; months?: number }, ctx: CallCtx): Promise<Fetched<ScheduleRowDto[]>>;
  };
  payments: {
    list(loanId: string, q: { months?: number; status?: 'all' | 'failed' | 'success' | 'pending' }, ctx: CallCtx): Promise<Fetched<PaymentDto[]>>;
    createLink(loanId: string, amount: Paise, idemKey: string, ctx: CallCtx): Promise<Fetched<PaymentLink>>;
  };
  policy: { byTopic(topic: PolicyTopic, ctx: CallCtx): Promise<Fetched<PolicyClauseDto[]>> };
  ops: {
    create(customerId: string, type: OpsRequestType, params: Record<string, unknown>, idemKey: string, ctx: CallCtx): Promise<Fetched<OpsRequestDto>>;
    list(customerId: string, ctx: CallCtx): Promise<Fetched<OpsRequestDto[]>>;
  };
  /** Drop cached stale-fallback entries for a system whose key starts with `prefix` (e.g. `lms:loan:PL-1`). */
  invalidate(system: SystemName, prefix: string): void;
}

export function buildConnectors(transport: Transport, cfg: Record<SystemName, ClientConfig> = DEFAULT_CLIENT_CONFIG): Connectors {
  const rc: Record<SystemName, ResilientClient> = {
    crm: new ResilientClient('crm', transport, cfg.crm),
    lms: new ResilientClient('lms', transport, cfg.lms),
    payments: new ResilientClient('payments', transport, cfg.payments),
    policy: new ResilientClient('policy', transport, cfg.policy),
    ops: new ResilientClient('ops', transport, cfg.ops),
  };
  const g = <T>(s: SystemName, path: string, cacheKey: string, ctx: CallCtx) => rc[s].get<T>(path, { ...ctx, cacheKey });

  return {
    crm: {
      getCustomer: (id, ctx) => g('crm', `/crm/customers/${e(id)}`, `crm:customer:${id}`, ctx),
      getInteractions: (id, ctx) =>
        map(g<{ interactions: Interaction[] }>('crm', `/crm/customers/${e(id)}/interactions`, `crm:interactions:${id}`, ctx), (b) => b.interactions),
    },
    lms: {
      getLoans: (cid, ctx) =>
        map(g<{ loans: LoanRecordDto[] }>('lms', `/lms/customers/${e(cid)}/loans`, `lms:loans:${cid}`, ctx), (b) => b.loans),
      getLoan: (loanId, ctx) => g('lms', `/lms/loans/${e(loanId)}`, `lms:loan:${loanId}`, ctx),
      getSchedule: (loanId, q, ctx) =>
        map(
          g<{ schedule: ScheduleRowDto[] }>('lms', `/lms/loans/${e(loanId)}/schedule${qs(q)}`, `lms:schedule:${loanId}:${q.from ?? ''}:${q.months ?? ''}`, ctx),
          (b) => b.schedule,
        ),
    },
    payments: {
      list: (loanId, q, ctx) =>
        map(
          g<{ payments: PaymentDto[] }>('payments', `/payments/loans/${e(loanId)}${qs(q)}`, `payments:list:${loanId}:${q.months ?? ''}:${q.status ?? ''}`, ctx),
          (b) => b.payments,
        ),
      createLink: (loanId, amount, idemKey, ctx) =>
        rc.payments.post<PaymentLink>('/payments/links', { loanId, amountPaise: amount }, { ...ctx, idempotencyKey: idemKey }),
    },
    policy: {
      byTopic: (topic, ctx) =>
        map(g<{ clauses: PolicyClauseDto[] }>('policy', `/policy/clauses${qs({ topic })}`, `policy:topic:${topic}`, ctx), (b) => b.clauses),
    },
    ops: {
      create: (customerId, type, params, idemKey, ctx) =>
        rc.ops.post<OpsRequestDto>('/ops/requests', { customerId, type, params }, { ...ctx, idempotencyKey: idemKey }),
      list: (customerId, ctx) =>
        map(g<{ requests: OpsRequestDto[] }>('ops', `/ops/requests${qs({ customerId })}`, `ops:requests:${customerId}`, ctx), (b) => b.requests),
    },
    invalidate: (system, prefix) => rc[system].invalidate(prefix),
  };
}
