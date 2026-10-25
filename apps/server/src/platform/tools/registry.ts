import { zodToJsonSchema } from 'zod-to-json-schema';
import { ToolFailure, type FunctionDeclaration, type ToolContext, type ToolDef, type ToolResult } from './types.js';

const STRIP = new Set(['$schema', 'additionalProperties', 'definitions', '$defs']);

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (!STRIP.has(k)) out[k] = clean(v);
    }
    return out;
  }
  return node;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  register(t: ToolDef): this {
    if (this.tools.has(t.name)) throw new Error(`Tool already registered: ${t.name}`);
    this.tools.set(t.name, t);
    return this;
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  declarations(names: string[]): FunctionDeclaration[] {
    return names.map((name) => {
      const t = this.tools.get(name);
      if (!t) throw new Error(`Unknown tool: ${name}`);
      const json = clean(zodToJsonSchema(t.schema, { $refStrategy: 'none', target: 'jsonSchema7' })) as Record<string, any>;
      return {
        name: t.name,
        description: t.description,
        parameters: { type: 'object', properties: json.properties ?? {}, ...(json.required && { required: json.required }) },
      };
    });
  }

  async run(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const t = this.tools.get(name);
    if (!t) return { ok: false, error: 'invalid', message: `Unknown tool: ${name}` };
    const parsed = t.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
      return { ok: false, error: 'invalid', message };
    }
    const end = ctx.tracer.span(`tool:${name}`);
    try {
      const r = await t.run(ctx, parsed.data);
      end({ ok: r.ok, ...(!r.ok && { error: r.error }) });
      return r;
    } catch (e) {
      if (e instanceof ToolFailure) {
        end({ ok: false, error: e.result.error });
        return e.result;
      }
      const aborted = e instanceof Error && e.name === 'AbortError';
      end({ ok: false, error: aborted ? 'cancelled' : 'internal', detail: e instanceof Error ? e.message : String(e) });
      return { ok: false, error: 'unavailable', message: aborted ? 'cancelled' : 'internal error' };
    }
  }
}
