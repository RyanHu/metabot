import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveProvider, PROVIDER_PRESETS } from '../src/engines/providers.js';

describe('providers', () => {
  const saved: Record<string, string | undefined> = {};
  const envKeys = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'DEEPSEEK_API_KEY',
    'MOONSHOT_API_KEY',
    'DASHSCOPE_API_KEY',
    'MINIMAX_API_KEY',
  ];

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

  it('returns undefined when no config provided', () => {
    expect(resolveProvider()).toBeUndefined();
    expect(resolveProvider(undefined)).toBeUndefined();
  });

  it('resolves a preset provider with inline apiKey', () => {
    const r = resolveProvider({ name: 'deepseek', apiKey: 'sk-test' });
    expect(r).toBeDefined();
    expect(r!.name).toBe('deepseek');
    expect(r!.baseUrl).toBe(PROVIDER_PRESETS.deepseek.baseUrl);
    expect(r!.authStyle).toBe('openai-compatible');
    expect(r!.apiKey).toBe('sk-test');
    expect(r!.defaultModels).toContain('deepseek-chat');
    expect(r!.extraEnv).toEqual({});
  });

  it('falls back to env var when apiKey absent', () => {
    process.env.MOONSHOT_API_KEY = 'env-moonshot-key';
    const r = resolveProvider({ name: 'kimi' });
    expect(r!.apiKey).toBe('env-moonshot-key');
  });

  it('allows baseUrl override of preset', () => {
    const r = resolveProvider({ name: 'openai', baseUrl: 'http://localhost:61050', apiKey: 'k' });
    expect(r!.baseUrl).toBe('http://localhost:61050');
  });

  it('forwards extraEnv to ResolvedProvider', () => {
    const r = resolveProvider({ name: 'anthropic', apiKey: 'k', env: { FOO: 'bar' } });
    expect(r!.extraEnv).toEqual({ FOO: 'bar' });
  });

  it('marks anthropic preset with anthropic authStyle, others openai-compatible', () => {
    expect(PROVIDER_PRESETS.anthropic.authStyle).toBe('anthropic');
    for (const name of ['openai', 'deepseek', 'kimi', 'qwen', 'minimax'] as const) {
      expect(PROVIDER_PRESETS[name].authStyle).toBe('openai-compatible');
    }
  });

  it('requires baseUrl for "custom" provider', () => {
    expect(() => resolveProvider({ name: 'custom' })).toThrow(/custom.*baseUrl/);
  });

  it('resolves "custom" provider with baseUrl', () => {
    const r = resolveProvider({ name: 'custom', baseUrl: 'https://my.proxy/v1', apiKey: 'x' });
    expect(r!.name).toBe('custom');
    expect(r!.baseUrl).toBe('https://my.proxy/v1');
    expect(r!.authStyle).toBe('openai-compatible');
    expect(r!.defaultModels).toEqual([]);
  });
});
