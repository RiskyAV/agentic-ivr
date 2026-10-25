import { formatDate, formatInr, formatPct, speakDate, speakInr, speakPct } from '@app/domain';
import type { Channel } from '@app/shared';

/** A typed figure produced by a tool. The LLM never writes these; it references them as `{{key}}`. */
export type BoundValue =
  | { kind: 'money'; paise: number }
  | { kind: 'pct'; bps: number }
  | { kind: 'date'; iso: string }
  | { kind: 'months'; n: number }
  | { kind: 'count'; n: number }
  | { kind: 'text'; s: string };

export const money = (paise: number): BoundValue => ({ kind: 'money', paise });
export const pct = (bps: number): BoundValue => ({ kind: 'pct', bps });
export const date = (iso: string): BoundValue => ({ kind: 'date', iso });
export const months = (n: number): BoundValue => ({ kind: 'months', n });
export const count = (n: number): BoundValue => ({ kind: 'count', n });
export const text = (s: string): BoundValue => ({ kind: 'text', s });

/** Display form for text channel, speech form for voice. */
export function formatBound(v: BoundValue, channel: Channel): string {
  const voice = channel === 'voice';
  switch (v.kind) {
    case 'money': return voice ? speakInr(v.paise) : formatInr(v.paise);
    case 'pct': return voice ? speakPct(v.bps) : formatPct(v.bps);
    case 'date': return voice ? speakDate(v.iso) : formatDate(v.iso);
    case 'months': return `${v.n} ${v.n === 1 ? 'month' : 'months'}`;
    case 'count': return String(v.n);
    case 'text': return v.s;
  }
}
