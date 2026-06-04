import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildProviderEnv } from '../src/engines/codex/executor.js';
import type { BotConfigBase } from '../src/config.js';

function baseConfig(provider?: BotConfigBase['provider']): BotConfigBase {
  return {
    name: 'test-bot',
    engine: 'codex',
    claude: {
      defaultWorkingDirectory: '/tmp',
      maxTurns: undefined,
      maxBudgetUsd: undefined,
      model: undefined,
      apiKey: undefined,
      outputsBaseDir: '/tmp/out',
      downloadsDir: '/tmp/dl',
    },
    ...(provider ? { provider } : {}),
  };
}

describe('codex buildProviderEnv', () => {
  const saved: Record<string, string | undefined> = {};
  const envKeys = ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY'];
  beforeEach(() => {
    for (const k of envKeys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('returns empty object when no provider configured', () => {
    expect(buildProviderEnv(baseConfig())).toEqual({});
  });

  it('emits OPENAI_BASE_URL + OPENAI_API_KEY for openai provider', () => {
    const env = buildProviderEnv(baseConfig({ name: 'openai', apiKey: 'sk-xyz' }));
    expect(env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1');
    expect(env.OPENAI_API_KEY).toBe('sk-xyz');
  });

  it('uses preset baseUrl for deepseek and forwards extraEnv', () => {
    const env = buildProviderEnv(
      baseConfig({ name: 'deepseek', apiKey: 'sk-ds', env: { CUSTOM: '1' } })
    );
    expect(env.OPENAI_BASE_URL).toBe('https://api.deepseek.com/v1');
    expect(env.OPENAI_API_KEY).toBe('sk-ds');
    expect(env.CUSTOM).toBe('1');
  });

  it('honors baseUrl override (point at LiteLLM)', () => {
    const env = buildProviderEnv(
      baseConfig({ name: 'qwen', baseUrl: 'http://localhost:61050', apiKey: 'router-key' })
    );
    expect(env.OPENAI_BASE_URL).toBe('http://localhost:61050');
    expect(env.OPENAI_API_KEY).toBe('router-key');
  });

  it('falls back to apiKey env var when not in config', () => {
    process.env.DASHSCOPE_API_KEY = 'env-qwen-key';
    const env = buildProviderEnv(baseConfig({ name: 'qwen' }));
    expect(env.OPENAI_API_KEY).toBe('env-qwen-key');
  });

  it('omits OPENAI_API_KEY when neither config nor env var supply one', () => {
    const env = buildProviderEnv(baseConfig({ name: 'minimax' }));
    expect(env.OPENAI_BASE_URL).toBe('https://api.minimax.chat/v1');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('routes anthropic-protocol provider via OPENAI_BASE_URL (proxy assumed)', () => {
    const env = buildProviderEnv(
      baseConfig({ name: 'anthropic', baseUrl: 'http://localhost:61050/anthropic', apiKey: 'k' })
    );
    expect(env.OPENAI_BASE_URL).toBe('http://localhost:61050/anthropic');
    expect(env.OPENAI_API_KEY).toBe('k');
  });
});
