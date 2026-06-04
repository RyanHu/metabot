# Multi-Provider LLM Routing

> Pick which backend LLM family (Anthropic / OpenAI / DeepSeek / Kimi / Qwen
> / MiniMax / custom) powers a bot's underlying CLI, independent of the
> engine (`claude` / `codex` / `kimi`).

## Why

The default mode is "Claude Code talks to Anthropic" and "Codex talks to OpenAI".
This module lets you mix and match — e.g. point Claude Code at DeepSeek (cheap
reasoning), or point Codex at Claude (coding-heavy). The decoupling lives in
the `provider` field on `BotConfigBase`.

## The provider field

In `bots.json`:

```json
{
  "name": "vibe-dev",
  "engine": "claude",
  "provider": {
    "name": "deepseek",
    "baseUrl": "http://192.168.50.14:61050",
    "apiKey": "sk-..."
  },
  "claude": {
    "model": "deepseek-chat",
    "defaultWorkingDirectory": "/work/vibe-dev"
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | `anthropic` / `openai` / `deepseek` / `kimi` / `qwen` / `minimax` / `custom` |
| `baseUrl` | required for `custom`, optional for presets | Overrides the preset endpoint (point at LiteLLM, your own proxy, etc.) |
| `apiKey` | optional | Inline. Falls back to `<NAME>_API_KEY` env var per the preset. |
| `env` | optional | Extra env vars forwarded to the spawned CLI |

`resolveProvider()` in `src/engines/providers.ts` merges the config against
`PROVIDER_PRESETS`, falling back to the provider's standard env var for the
key (e.g. `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`,
`DASHSCOPE_API_KEY`, `MINIMAX_API_KEY`).

## How the env injection works

Each engine speaks one protocol natively:

| Engine | Native protocol | Env vars injected |
|---|---|---|
| `claude` | Anthropic Messages API | `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` |
| `codex` | OpenAI Chat Completions | `OPENAI_BASE_URL`, `OPENAI_API_KEY` |
| `kimi` | Moonshot SDK | (no provider injection — Kimi SDK owns auth) |

When you set `provider`, those env vars are set to the resolved
`(baseUrl, apiKey)` and forwarded to the child process — plus any `provider.env`
on top.

**Cross-protocol use** (e.g. Claude Code → DeepSeek, or Codex → Claude) needs
a translating proxy because the engine only emits its native wire format. The
ai-studio deployment ships **LiteLLM** at `http://192.168.50.14:61050` for
exactly that — it exposes both `/v1/chat/completions` and `/v1/messages` and
routes by `model` name. Point `provider.baseUrl` at it.

## Built-in presets

| name | default baseUrl | authStyle | key env var |
|---|---|---|---|
| `anthropic` | https://api.anthropic.com | anthropic | `ANTHROPIC_API_KEY` |
| `openai` | https://api.openai.com/v1 | openai-compatible | `OPENAI_API_KEY` |
| `deepseek` | https://api.deepseek.com/v1 | openai-compatible | `DEEPSEEK_API_KEY` |
| `kimi` | https://api.moonshot.cn/v1 | openai-compatible | `MOONSHOT_API_KEY` |
| `qwen` | https://dashscope.aliyuncs.com/compatible-mode/v1 | openai-compatible | `DASHSCOPE_API_KEY` |
| `minimax` | https://api.minimax.chat/v1 | openai-compatible | `MINIMAX_API_KEY` |
| `custom` | (required in config) | openai-compatible | (no fallback) |

## Precedence

For Claude:
1. `provider.apiKey` (most specific)
2. `claude.apiKey` from bots.json
3. Inherited `ANTHROPIC_API_KEY` from process env

For Codex:
1. `codex.env` overrides (most specific)
2. `provider.env` extras
3. Resolved `provider` env (`OPENAI_BASE_URL` / `OPENAI_API_KEY`)
4. Inherited process env

## Examples

See `bots.example.json` — entries `project-epsilon` (Claude → DeepSeek via
LiteLLM), `project-zeta` (Codex → Anthropic via LiteLLM), `project-eta`
(Codex → DeepSeek direct, no proxy).

## Testing

- `tests/providers.test.ts` — resolveProvider() unit tests
- `tests/codex-provider-env.test.ts` — codex spawn env shape

## Future work

- M4 management UI: provider dropdown + per-bot virtual key issuance via
  LiteLLM `/key/generate`.
- Usage dashboard reading from LiteLLM's PostgreSQL backend (when enabled).
