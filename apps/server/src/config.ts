import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { engineConfigFromEnv, type EngineConfig } from './platform/engine/engine.js';

export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
export const DEFAULT_GUARD_MODEL = 'gemini-3.5-flash-lite';

export interface Config {
  port: number;
  /** Listen address: 0.0.0.0 by default (containers); 127.0.0.1 behind a local reverse proxy. */
  host: string;
  /** TRUST_PROXY=1: take the client IP from X-Forwarded-For set by a reverse proxy on loopback (login rate limit per real IP). */
  trustLoopbackProxy: boolean;
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
  /** Per-chunk delay of the stub LLM (LLM_PROVIDER=stub only); load tests use it to model model latency. */
  stubChunkDelayMs: number;
  /** TEST_HOOKS=1 enables /api/test/* (ages the connector cache so the eval can produce a clearly stale answer). Never in production. */
  testHooks: boolean;
  voice: VoiceSettings;
  eventLogDir: string;
  engine: EngineConfig;
}

export interface VoiceSettings {
  /** Voice is enabled only when both the ElevenLabs key and a voice id are set. */
  elevenLabsApiKey?: string;
  voiceId?: string;
  ttsModel: string;
  sttSilenceSecs: number;
  bargeInMinWords: number;
  /** Sustained mic energy (ms) that interrupts the assistant; 0 = transcript-only barge-in. */
  bargeInVadMs: number;
  bargeInVadDb: number;
  /** dB above the adaptive noise floor a frame needs to count as voice. */
  bargeInVadMarginDb: number;
  fillerAfterMs: number;
  /** A voice session with no committed transcript and no assistant audio for this long is stopped (cost, slot lockout). */
  idleMs: number;
  /** Hard cap on one voice session's length. */
  maxMs: number;
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
  const testHooks = env.TEST_HOOKS === '1';
  if (testHooks && env.NODE_ENV === 'production') {
    throw new ConfigError('TEST_HOOKS=1 is not allowed with NODE_ENV=production (it exposes /api/test/* endpoints).');
  }
  const model = str(env, 'GEMINI_MODEL', DEFAULT_MODEL);
  const config: Config = {
    port: num(env, 'PORT', 4000, 0),
    host: str(env, 'HOST', '0.0.0.0'),
    trustLoopbackProxy: env.TRUST_PROXY === '1',
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
    stubChunkDelayMs: num(env, 'STUB_CHUNK_DELAY_MS', 0, 0),
    testHooks,
    voice: {
      ...(env.ELEVENLABS_API_KEY?.trim() && { elevenLabsApiKey: env.ELEVENLABS_API_KEY.trim() }),
      ...(env.ELEVENLABS_VOICE_ID?.trim() && { voiceId: env.ELEVENLABS_VOICE_ID.trim() }),
      ttsModel: str(env, 'ELEVENLABS_TTS_MODEL', 'eleven_flash_v2_5'),
      sttSilenceSecs: num(env, 'STT_SILENCE_SECS', 0.45, 0.1),
      bargeInMinWords: num(env, 'BARGE_IN_MIN_WORDS', 2),
      bargeInVadMs: num(env, 'BARGE_IN_VAD_MS', 500, 0),
      bargeInVadDb: num(env, 'BARGE_IN_VAD_DB', -40, -90),
      bargeInVadMarginDb: num(env, 'BARGE_IN_VAD_MARGIN_DB', 15, 0),
      fillerAfterMs: num(env, 'FILLER_AFTER_MS', 700, 0),
      idleMs: num(env, 'VOICE_IDLE_MS', 120_000, 1000),
      maxMs: num(env, 'VOICE_MAX_MS', 900_000, 1000),
    },
    eventLogDir: str(env, 'EVENT_LOG_DIR', fileURLToPath(new URL('../../../.data/events', import.meta.url))),
    engine: engineConfigFromEnv({ ...env, GEMINI_MODEL: model }),
  };
  if (env.NODE_ENV === 'production' && !config.demoAccessCode) {
    warnings.push('NODE_ENV=production with an empty DEMO_ACCESS_CODE: anyone with the URL can log in and change chaos.');
  }
  if (!config.voice.elevenLabsApiKey || !config.voice.voiceId) warnings.push('ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID not set; voice mode is disabled.');
  return { config, warnings };
}
