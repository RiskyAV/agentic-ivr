import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';
import { engineConfigFromEnv } from './platform/engine/engine.js';

describe('loadConfig', () => {
  it('fails fast without an API key for the gemini provider', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'gemini' })).toThrow(/GEMINI_API_KEY is required/);
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it('rejects an unknown provider and malformed numbers', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'openai' })).toThrow(/LLM_PROVIDER/);
    expect(() => loadConfig({ LLM_PROVIDER: 'stub', TURN_RATE_PER_MIN: 'abc' })).toThrow(/TURN_RATE_PER_MIN/);
  });

  it('defaults: flash-lite models, random secret with a warning, dev web origin', () => {
    const { config, warnings } = loadConfig({ LLM_PROVIDER: 'stub' });
    expect(config.model).toBe('gemini-3.5-flash-lite');
    expect(config.guardModel).toBe('gemini-3.5-flash-lite');
    expect(config.sessionSecret).toHaveLength(64);
    expect(warnings.join(' ')).toMatch(/SESSION_SECRET/);
    expect(config.webOrigins).toEqual(['http://localhost:5173']);
    expect(config.engine.guardWaitMs).toBe(2000);
    expect(config.engine.model).toBe('gemini-3.5-flash-lite');
    expect(loadConfig({ LLM_PROVIDER: 'stub' }).config.sessionSecret).not.toBe(config.sessionSecret);
  });

  it('voice settings: disabled without ElevenLabs credentials, defaults and overrides', () => {
    const off = loadConfig({ LLM_PROVIDER: 'stub' });
    expect(off.config.voice).toEqual({ ttsModel: 'eleven_flash_v2_5', sttSilenceSecs: 0.45, bargeInMinWords: 2, bargeInVadMs: 400, bargeInVadDb: -40, fillerAfterMs: 700 });
    expect(off.warnings.join(' ')).toMatch(/voice mode is disabled/);
    const on = loadConfig({
      LLM_PROVIDER: 'stub', ELEVENLABS_API_KEY: 'k', ELEVENLABS_VOICE_ID: 'v', STT_SILENCE_SECS: '0.3', BARGE_IN_MIN_WORDS: '3', BARGE_IN_VAD_MS: '0', FILLER_AFTER_MS: '500',
    }).config.voice;
    expect(on).toMatchObject({ elevenLabsApiKey: 'k', voiceId: 'v', sttSilenceSecs: 0.3, bargeInMinWords: 3, bargeInVadMs: 0, fillerAfterMs: 500 });
    expect(() => loadConfig({ LLM_PROVIDER: 'stub', BARGE_IN_MIN_WORDS: '0' })).toThrow(/BARGE_IN_MIN_WORDS/);
  });

  it('reads explicit values', () => {
    const { config, warnings } = loadConfig({
      LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'k', GEMINI_MODEL: 'm', SESSION_SECRET: 's', PORT: '5000', ELEVENLABS_API_KEY: 'e', ELEVENLABS_VOICE_ID: 'v',
      WEB_ORIGIN: 'https://a.example/, https://b.example', DEMO_ACCESS_CODE: 'x', GUARD_WAIT_MS: '2500',
    });
    expect(warnings).toEqual([]);
    expect(config).toMatchObject({ model: 'm', port: 5000, demoAccessCode: 'x', geminiApiKey: 'k' });
    expect(config.webOrigins).toEqual(['http://localhost:5173', 'https://a.example', 'https://b.example']);
    expect(config.engine.guardWaitMs).toBe(2500);
  });
});

describe('engineConfigFromEnv', () => {
  it('GUARD_WAIT_MS defaults to 2000 and ignores junk', () => {
    expect(engineConfigFromEnv({}).guardWaitMs).toBe(2000);
    expect(engineConfigFromEnv({ GUARD_WAIT_MS: '1200' }).guardWaitMs).toBe(1200);
    expect(engineConfigFromEnv({ GUARD_WAIT_MS: 'x' }).guardWaitMs).toBe(2000);
  });
});
