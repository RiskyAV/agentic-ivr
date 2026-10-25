import type { z } from 'zod';
import type { Channel, Source, TableView } from '@app/shared';
import type { Connectors } from '../connectors/clients.js';
import type { Session } from '../context/session.js';
import type { BoundValue } from '../grounding/values.js';
import type { TurnTracer } from '../telemetry/tracer.js';

export interface ToolContext {
  customerId: string;
  session: Session;
  turnId: string;
  channel: Channel;
  connectors: Connectors;
  tracer: TurnTracer;
  signal: AbortSignal;
  /** Business date for every calculation (ISO). */
  today: string;
}

export type ToolFailureResult = {
  ok: false;
  error: 'unavailable' | 'not_found' | 'forbidden' | 'invalid' | 'ambiguous';
  message: string;
  options?: { id: string; label: string }[];
  /** Figures worth binding even on failure (e.g. the minimum prepayment). */
  values?: Record<string, BoundValue>;
};

export type ToolResult =
  | {
      ok: true;
      data: unknown;
      values: Record<string, BoundValue>;
      sources: Source[];
      tables?: TableView[];
      stale?: { asOf: string };
    }
  | ToolFailureResult;

export interface ToolDef<A = any> {
  name: string;
  description: string;
  schema: z.ZodType<A, z.ZodTypeDef, any>;
  kind: 'read' | 'calc' | 'propose';
  /** Spoken while the tool runs on the voice channel. */
  filler?: string;
  run(ctx: ToolContext, args: A): Promise<ToolResult>;
}

/** Gemini-compatible function declaration: plain JSON schema, no $schema / $ref / additionalProperties. */
export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

/** Thrown inside a tool to return a failure result; caught by the registry. */
export class ToolFailure extends Error {
  constructor(readonly result: ToolFailureResult) {
    super(result.message);
  }
}
