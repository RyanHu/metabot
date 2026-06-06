import { describe, it, expect } from 'vitest';
import { buildSpawnEnv } from '../src/engines/claude/persistent-executor.js';
import type { ResolvedProvider } from '../src/engines/providers.js';

/**
 * Regression — M5.5-D bug fix.
 *
 * Before this fix, PersistentClaudeExecutor's createSpawnFn ignored the
 * bot's `provider` configuration. A bot like 棉花 (configured to route
 * through 火山引擎 Coding Plan) would still hit Opus because the SDK
 * subprocess inherited `~/.claude/.credentials.json` (Opus subscription)
 * and no `ANTHROPIC_BASE_URL` override.
 *
 * The non-persistent ClaudeExecutor in executor.ts always passed provider
 * env correctly; only the persistent code path missed it. These tests pin
 * the fix at the buildSpawnEnv() boundary so the persistent path can never
 * silently fall back to credentials.json again.
 */

function mkProvider(overrides: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    name: 'custom',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    apiKey: 'ark-test-key',
    authStyle: 'openai-compatible',
    extraEnv: {},
    ...overrides,
  };
}

describe('PersistentClaudeExecutor buildSpawnEnv — provider override (M5.5-D)', () => {
  it('injects ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY + ANTHROPIC_AUTH_TOKEN from provider', () => {
    const env = buildSpawnEnv({} as NodeJS.ProcessEnv, undefined, undefined, mkProvider(), false);
    expect(env.ANTHROPIC_BASE_URL).toBe('https://ark.cn-beijing.volces.com/api/coding');
    expect(env.ANTHROPIC_API_KEY).toBe('ark-test-key');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('ark-test-key');
  });

  it('provider override beats local credentials.json (Opus subscription fallback)', () => {
    // The bug shape: credentials file exists, no explicit apiKey, but
    // provider is set. Without the fix, AUTH_ENV_VARS would be filtered
    // away and the subprocess would fall back to credentials.json.
    const env = buildSpawnEnv({} as NodeJS.ProcessEnv, undefined, undefined, mkProvider(), true);
    expect(env.ANTHROPIC_BASE_URL).toBe('https://ark.cn-beijing.volces.com/api/coding');
    expect(env.ANTHROPIC_API_KEY).toBe('ark-test-key');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('ark-test-key');
  });

  it('forwards provider.extraEnv', () => {
    const env = buildSpawnEnv(
      {} as NodeJS.ProcessEnv,
      undefined,
      undefined,
      mkProvider({ extraEnv: { ANTHROPIC_BETAS: 'foo', CUSTOM_VAR: '1' } }),
      false,
    );
    expect(env.ANTHROPIC_BETAS).toBe('foo');
    expect(env.CUSTOM_VAR).toBe('1');
  });

  it('does NOT inject Anthropic env vars when no provider configured', () => {
    const env = buildSpawnEnv({} as NodeJS.ProcessEnv, undefined, undefined, undefined, false);
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('explicit apiKey wins for ANTHROPIC_API_KEY when no provider is set', () => {
    const env = buildSpawnEnv({} as NodeJS.ProcessEnv, undefined, 'sk-explicit', undefined, false);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-explicit');
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('strips inherited CLAUDE_* vars (nested-session guard) but keeps allow-list', () => {
    const inherited = {
      CLAUDE_PROJECT_DIR: '/foo',                       // stripped
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',        // allowed
    } as unknown as NodeJS.ProcessEnv;
    const env = buildSpawnEnv(inherited, undefined, undefined, mkProvider(), false);
    expect(env.CLAUDE_PROJECT_DIR).toBeUndefined();
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
  });

  it('defaults CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 and CLAUDE_CODE_DISABLE_AUTO_MEMORY=0', () => {
    const env = buildSpawnEnv({} as NodeJS.ProcessEnv, undefined, undefined, undefined, false);
    expect(env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1');
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('0');
  });
});
