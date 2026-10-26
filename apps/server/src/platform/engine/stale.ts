import { text, type BoundValue } from '../grounding/values.js';

/** "5 minutes ago (at 14:03 UTC)": the age leads, so the customer hears that the data is not live. */
export function describeStale(asOfIso: string, nowMs: number): string {
  const at = Date.parse(asOfIso);
  const mins = Math.max(0, Math.floor((nowMs - at) / 60_000));
  const hours = Math.floor(mins / 60);
  const age =
    mins < 1 ? 'less than a minute ago'
    : mins < 60 ? `${mins} ${mins === 1 ? 'minute' : 'minutes'} ago`
    : `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  return `${age} (at ${new Date(at).toISOString().slice(11, 16)} UTC)`;
}

/**
 * Bound values for stale tool results: `stale.<tool>.as_of` for each stale tool, and `stale.as_of` = the oldest of them,
 * so a turn that mixes ages never presents the newest data's age for the oldest data.
 */
export function staleValues(asOfByTool: Record<string, string>, nowMs: number): Record<string, BoundValue> {
  const out: Record<string, BoundValue> = {};
  const entries = Object.entries(asOfByTool);
  for (const [tool, asOf] of entries) out[`stale.${tool}.as_of`] = text(describeStale(asOf, nowMs));
  if (entries.length > 0) out['stale.as_of'] = text(describeStale(entries.map(([, a]) => a).sort()[0]!, nowMs));
  return out;
}
