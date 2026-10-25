import type { WorkflowDefinition } from './types.js';

export class WorkflowRegistry {
  private readonly m = new Map<string, WorkflowDefinition>();

  register(def: WorkflowDefinition): this {
    if (this.m.has(def.id)) throw new Error(`Workflow already registered: ${def.id}`);
    this.m.set(def.id, def);
    return this;
  }

  get(id: string): WorkflowDefinition | undefined {
    return this.m.get(id);
  }

  list(): WorkflowDefinition[] {
    return [...this.m.values()];
  }
}
