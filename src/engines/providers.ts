/**
 * LLM provider abstraction.
 *
 * Lets a bot pick a backend model family (`anthropic`, `openai`, `deepseek`,
 * `kimi`, `qwen`, `minimax`, `custom`) independently of the engine
 * (`claude` / `codex` / `kimi`). The resolved provider supplies the base URL,
 * auth style, and default model list. Engine executors consume this to inject
 * the correct env vars (e.g. `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`) when
 * spawning the underlying CLI.
 *
 * This module is type/data only — it does not perform side effects. Wiring
 * into the spawn paths lives in claude/codex executors (separate PR).
 */

export type ProviderName =
  | 'anthropic'
  | 'openai'
  | 'deepseek'
  | 'kimi'
  | 'qwen'
  | 'minimax'
  | 'custom';

/** How auth/base URL gets passed to the underlying CLI process. */
export type AuthStyle = 'anthropic' | 'openai-compatible';

export interface ProviderPreset {
  /** Default base URL when the bot config does not override. */
  baseUrl: string;
  /** Drives which env-var family the engine should set when spawning the CLI. */
  authStyle: AuthStyle;
  /** Shown in the management UI as model dropdown. Bots may override per-config. */
  defaultModels: string[];
  /** Fallback env var to read the API key from when not in bots.json. */
  apiKeyEnvVar?: string;
  description?: string;
}

/**
 * Built-in provider table. Bots reference one of these by name. The `custom`
 * provider is open-ended and always requires an explicit `baseUrl`.
 */
export const PROVIDER_PRESETS: Record<Exclude<ProviderName, 'custom'>, ProviderPreset> = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    authStyle: 'anthropic',
    defaultModels: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    description: 'Anthropic Claude — 官方端点',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    authStyle: 'openai-compatible',
    defaultModels: ['gpt-5.4-codex', 'gpt-5-turbo', 'o3-mini', 'gpt-4o'],
    apiKeyEnvVar: 'OPENAI_API_KEY',
    description: 'OpenAI 官方',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    authStyle: 'openai-compatible',
    defaultModels: ['deepseek-chat', 'deepseek-reasoner'],
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    description: 'DeepSeek（OpenAI 兼容）',
  },
  kimi: {
    baseUrl: 'https://api.moonshot.cn/v1',
    authStyle: 'openai-compatible',
    defaultModels: ['kimi-latest', 'kimi-k2-coder', 'moonshot-v1-128k'],
    apiKeyEnvVar: 'MOONSHOT_API_KEY',
    description: 'Moonshot Kimi（OpenAI 兼容）',
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    authStyle: 'openai-compatible',
    defaultModels: ['qwen3-max', 'qwen3-coder', 'qwen2.5-72b-instruct'],
    apiKeyEnvVar: 'DASHSCOPE_API_KEY',
    description: '阿里通义千问（DashScope OpenAI 兼容模式）',
  },
  minimax: {
    baseUrl: 'https://api.minimax.chat/v1',
    authStyle: 'openai-compatible',
    defaultModels: ['MiniMax-M2', 'abab7-chat-preview'],
    apiKeyEnvVar: 'MINIMAX_API_KEY',
    description: 'MiniMax（OpenAI 兼容）',
  },
};

/** Bot-level provider configuration as it appears in bots.json. */
export interface ProviderConfig {
  name: ProviderName;
  /** Overrides preset's baseUrl. Required when name === 'custom'. */
  baseUrl?: string;
  /** Inline API key. When absent, falls back to preset's apiKeyEnvVar. */
  apiKey?: string;
  /** Extra env vars to forward to spawned CLI (engine-specific knobs). */
  env?: Record<string, string>;
}

/** Resolved provider that engines consume at spawn time. */
export interface ResolvedProvider {
  name: ProviderName;
  baseUrl: string;
  apiKey?: string;
  authStyle: AuthStyle;
  defaultModels: string[];
  extraEnv: Record<string, string>;
}

/**
 * Resolve a `ProviderConfig` against the preset table, falling back to env
 * vars for the API key. Returns `undefined` when input is absent — callers
 * keep their current behavior (use process env / built-in defaults).
 */
export function resolveProvider(cfg?: ProviderConfig): ResolvedProvider | undefined {
  if (!cfg) return undefined;
  if (cfg.name === 'custom') {
    if (!cfg.baseUrl) {
      throw new Error('Provider "custom" requires an explicit baseUrl in bot config');
    }
    return {
      name: 'custom',
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      authStyle: 'openai-compatible',
      defaultModels: [],
      extraEnv: cfg.env ?? {},
    };
  }
  const preset = PROVIDER_PRESETS[cfg.name];
  if (!preset) {
    throw new Error(`Unknown provider name: ${cfg.name}`);
  }
  const apiKey = cfg.apiKey ?? (preset.apiKeyEnvVar ? process.env[preset.apiKeyEnvVar] : undefined);
  return {
    name: cfg.name,
    baseUrl: cfg.baseUrl ?? preset.baseUrl,
    apiKey,
    authStyle: preset.authStyle,
    defaultModels: preset.defaultModels,
    extraEnv: cfg.env ?? {},
  };
}
