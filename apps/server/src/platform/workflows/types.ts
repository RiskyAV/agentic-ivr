import type { PolicyTopic } from '@app/domain';
import type { CustomerSnapshot } from '../context/snapshot.js';

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  /** Tool names, resolved against the ToolRegistry. */
  tools: string[];
  /** Action types (each exposed to the model as `propose_<type>`). */
  actions: string[];
  policyTopics: PolicyTopic[];
  /** Proactive first line for a fresh session, if any. */
  opener?: (s: CustomerSnapshot) => string | null;
  voice?: { fillers?: Record<string, string> };
  /** Short starter prompts shown in the UI. */
  suggestions: string[];
}
