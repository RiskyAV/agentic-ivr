import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { engineConfigFromEnv, type EngineConfig } from './platform/engine/engine.js';

export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_GUARD_MODEL = 'gemini-3.5-flash-lite';

export interface Config {
  port: number;
  mockBaseUrl: string;
  llmProvider: 'gemini' | 'stub';
  geminiApiKey?: string;
  model: string;
  guardModel: string;
  sessionSecret: string;
  /** Empty string disables the gate. */
  demoAccessCode: string;
  webOrigins: string[];
  loginsPerMin: number;
  turnsPerMin: number;
  llmMaxConcurrency: number;
  llmQueueTimeoutMs: number;
  maxVoiceSessions: number;
  eventLogDir: string;
  engine: EngineConfig;
}

export class ConfigError extends Error {}

/** Loads the repo-root `.env` into process.env (existing variables win). Silent when the file is absent. */
export function loadRootEnv(path = fileURLToPath(new URL('../../../.env', import.meta.url))): boolean {
  if (!existsSync(path)) return false;
  try {
    process.loadEnvFile(path);
    return true;
  } catch (err) {
    console.warn(`[config] could not read ${path}: ${(err as Error).message}`);
    return false;
  }
}

function num(env: Record<string, string | undefined>, key: string, dflt: number, min = 1): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new ConfigError(`${key} must be a number >= ${min} (got "${raw}")`);
  return n;
}

const str = (env: Record<string, string | undefined>, key: string, dflt: string) => (env[key]?.trim() ? env[key]!.trim() : dflt);

/** Typed, validated config from env. Throws ConfigError on invalid input; `warnings` lists soft problems. */
export function loadConfig(env: Record<string, string | undefined> = process.env): { config: Config; warnings: string[] } {
  const warnings: string[] = [];
  const provider = str(env, 'LLM_PROVIDER', 'gemini');
  if (provider !== 'gemini' && provider !== 'stub') throw new ConfigError(`LLM_PROVIDER must be "gemini" or "stub" (got "${provider}")`);
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (provider === 'gemini' && !apiKey) {
    throw new ConfigError('GEMINI_API_KEY is required when LLM_PROVIDER=gemini. Set it in .env, or use LLM_PROVIDER=stub to run without a model.');
  }
  let sessionSecret = env.SESSION_SECRET?.trim() ?? '';
  if (!sessionSecret) {
    sessionSecret = randomBytes(32).toString('hex');
    warnings.push('SESSION_SECRET is not set; generated a random one. Sessions will not survive a restart.');
  }
  const model = str(env, 'GEMINI_MODEL', DEFAULT_MODEL);
  const config: Config = {
    port: num(env, 'PORT', 4000, 0),
    mockBaseUrl: str(env, 'MOCK_BASE_URL', 'http://127.0.0.1:4100'),
    llmProvider: provider,
    ...(apiKey && { geminiApiKey: apiKey }),
    model,
    guardModel: str(env, 'GEMINI_GUARD_MODEL', DEFAULT_GUARD_MODEL),
    sessionSecret,
    demoAccessCode: env.DEMO_ACCESS_CODE?.trim() ?? '',
    webOrigins: ['http://localhost:5173', ...(env.WEB_ORIGIN ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)],
    loginsPerMin: num(env, 'LOGIN_RATE_PER_MIN', 10),
    turnsPerMin: num(env, 'TURN_RATE_PER_MIN', 30),
    llmMaxConcurrency: num(env, 'LLM_MAX_CONCURRENCY', 50),
    llmQueueTimeoutMs: num(env, 'LLM_QUEUE_TIMEOUT_MS', 4000),
    maxVoiceSessions: num(env, 'MAX_VOICE_SESSIONS', 5, 0),
    eventLogDir: str(env, 'EVENT_LOG_DIR', fileURLToPath(new URL('../../../.data/events', import.meta.url))),
    engine: engineConfigFromEnv({ ...env, GEMINI_MODEL: model }),
  };
  return { config, warnings };
}
