import { useState, useCallback } from 'react';
import { useStore } from '../store';
import type { BotInfo } from '../types';
import styles from './BotManageDialog.module.css';

interface BotManageDialogProps {
  mode: 'create' | 'edit';
  bot?: BotInfo;
  onClose: () => void;
}

type ProviderName = '' | 'anthropic' | 'openai' | 'deepseek' | 'kimi' | 'qwen' | 'minimax' | 'custom';

const PROVIDER_DEFAULTS: Record<Exclude<ProviderName, '' | 'custom'>, { baseUrl: string; hint: string }> = {
  anthropic: { baseUrl: 'https://api.anthropic.com', hint: 'claude-opus-4-7' },
  openai:    { baseUrl: 'https://api.openai.com/v1', hint: 'gpt-5.4-codex' },
  deepseek:  { baseUrl: 'https://api.deepseek.com/v1', hint: 'deepseek-chat' },
  kimi:      { baseUrl: 'https://api.moonshot.cn/v1', hint: 'kimi-latest' },
  qwen:      { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', hint: 'qwen3-max' },
  minimax:   { baseUrl: 'https://api.minimax.chat/v1', hint: 'MiniMax-M2' },
};

export function BotManageDialog({ mode, bot, onClose }: BotManageDialogProps) {
  const token = useStore((s) => s.token);

  const [name, setName] = useState(bot?.name || '');
  const [platform, setPlatform] = useState(bot?.platform || 'web');
  const [engine, setEngine] = useState(bot?.engine || 'claude');
  const [workDir, setWorkDir] = useState(bot?.workingDirectory || '');
  const [description, setDescription] = useState(bot?.description || '');
  const [model, setModel] = useState(bot?.model || '');
  const [maxTurns, setMaxTurns] = useState('');
  const [maxBudget, setMaxBudget] = useState('');
  const [providerName, setProviderName] = useState<ProviderName>(bot?.providerName || '');
  const [providerBaseUrl, setProviderBaseUrl] = useState('');
  const [providerApiKey, setProviderApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleProviderChange = useCallback((next: ProviderName) => {
    setProviderName(next);
    if (next && next !== 'custom') {
      setProviderBaseUrl((cur) => cur || PROVIDER_DEFAULTS[next].baseUrl);
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!name.trim() || !workDir.trim()) {
      setError('Name and working directory are required');
      return;
    }
    setLoading(true);
    setError('');

    const body: Record<string, unknown> = {
      name: name.trim(),
      platform,
      defaultWorkingDirectory: workDir.trim(),
      engine,
    };
    if (description.trim()) body.description = description.trim();
    if (model.trim()) body.model = model.trim();
    if (engine === 'codex' && model.trim()) body.codex = { model: model.trim() };
    if (maxTurns.trim()) body.maxTurns = parseInt(maxTurns, 10);
    if (maxBudget.trim()) body.maxBudgetUsd = parseFloat(maxBudget);

    if (providerName) {
      // `custom` must supply baseUrl; presets only need it if the user overrides.
      if (providerName === 'custom' && !providerBaseUrl.trim()) {
        setError('Custom provider requires a Base URL');
        setLoading(false);
        return;
      }
      const provider: Record<string, unknown> = { name: providerName };
      if (providerBaseUrl.trim()) provider.baseUrl = providerBaseUrl.trim();
      if (providerApiKey.trim()) provider.apiKey = providerApiKey.trim();
      body.provider = provider;
    }

    try {
      const url = mode === 'create'
        ? '/api/bots'
        : `/api/bots/${encodeURIComponent(bot!.name)}`;
      const method = mode === 'create' ? 'POST' : 'PUT';
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }, [name, platform, engine, workDir, description, model, maxTurns, maxBudget, providerName, providerBaseUrl, providerApiKey, mode, bot, token, onClose]);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.title}>
          {mode === 'create' ? 'Add Bot' : `Edit ${bot?.name}`}
        </h2>

        <div className={styles.form}>
          <label className={styles.field}>
            <span className={styles.label}>Name</span>
            <input
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-bot"
              disabled={mode === 'edit'}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Platform</span>
            <select
              className={styles.input}
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              disabled={mode === 'edit'}
            >
              <option value="web">Web</option>
              <option value="feishu">Feishu</option>
              <option value="telegram">Telegram</option>
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Working Directory</span>
            <input
              className={styles.input}
              value={workDir}
              onChange={(e) => setWorkDir(e.target.value)}
              placeholder="/home/user/project"
            />
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Engine</span>
            <select
              className={styles.input}
              value={engine}
              onChange={(e) => setEngine(e.target.value as 'claude' | 'kimi' | 'codex')}
            >
              <option value="claude">Claude Code</option>
              <option value="kimi">Kimi Code</option>
              <option value="codex">Codex CLI</option>
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.label}>Description (optional)</span>
            <input
              className={styles.input}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this bot does"
            />
          </label>

          <div className={styles.row}>
            <label className={styles.field}>
              <span className={styles.label}>Model (optional)</span>
              <input
                className={styles.input}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={providerName && providerName !== 'custom' ? PROVIDER_DEFAULTS[providerName].hint : (engine === 'codex' ? 'gpt-5.4-codex' : engine === 'kimi' ? 'kimi-for-coding' : 'claude-opus-4-7')}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Max Turns</span>
              <input
                className={styles.input}
                type="number"
                value={maxTurns}
                onChange={(e) => setMaxTurns(e.target.value)}
                placeholder="30"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Budget ($)</span>
              <input
                className={styles.input}
                type="number"
                step="0.1"
                value={maxBudget}
                onChange={(e) => setMaxBudget(e.target.value)}
                placeholder="5.00"
              />
            </label>
          </div>

          <label className={styles.field}>
            <span className={styles.label}>Provider (optional — overrides engine default endpoint)</span>
            <select
              className={styles.input}
              value={providerName}
              onChange={(e) => handleProviderChange(e.target.value as ProviderName)}
            >
              <option value="">(use engine default)</option>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="deepseek">DeepSeek</option>
              <option value="kimi">Moonshot / Kimi</option>
              <option value="qwen">Qwen (DashScope)</option>
              <option value="minimax">MiniMax</option>
              <option value="custom">Custom (LiteLLM / self-hosted)</option>
            </select>
          </label>

          {providerName && (
            <div className={styles.row}>
              <label className={styles.field}>
                <span className={styles.label}>Base URL{providerName === 'custom' ? ' *' : ''}</span>
                <input
                  className={styles.input}
                  value={providerBaseUrl}
                  onChange={(e) => setProviderBaseUrl(e.target.value)}
                  placeholder={providerName === 'custom' ? 'http://192.168.50.14:61050' : PROVIDER_DEFAULTS[providerName].baseUrl}
                />
              </label>
              <label className={styles.field}>
                <span className={styles.label}>API Key (optional, falls back to env)</span>
                <input
                  className={styles.input}
                  type="password"
                  value={providerApiKey}
                  onChange={(e) => setProviderApiKey(e.target.value)}
                  placeholder="sk-..."
                />
              </label>
            </div>
          )}
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onClose}>
            Cancel
          </button>
          <button
            className={styles.submitBtn}
            onClick={handleSubmit}
            disabled={loading}
          >
            {loading ? 'Saving...' : mode === 'create' ? 'Create' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
