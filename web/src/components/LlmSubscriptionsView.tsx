import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import styles from './LlmSubscriptionsView.module.css';

type AuthMode = 'subscription_cli' | 'api_key' | 'none';

interface Subscription {
  provider: string;
  displayName: string;
  authMode: AuthMode;
  loggedIn: boolean;
  account?: string;
  plan?: string;
  quotaWindow?: string;
  quotaUsedPct?: number;
  quotaUsedRaw?: string;
  quotaResetAt?: number;
  lastCheckedAt: number;
  sourceConfidence: 'official_api' | 'cli_parse' | 'local_estimate' | 'unknown';
  errors?: string[];
}

interface UsageSummary {
  window: string;
  byProvider: Record<string, { tokensIn: number; tokensOut: number; costUsd: number; calls: number }>;
}

function pctBarColor(pct?: number): string {
  if (pct === undefined) return 'var(--border)';
  if (pct > 85) return '#e07b39';
  if (pct > 60) return '#d4b34d';
  return '#6da66a';
}

function confidenceLabel(c: Subscription['sourceConfidence']): string {
  switch (c) {
    case 'official_api': return '官方 API';
    case 'cli_parse': return 'CLI 输出解析';
    case 'local_estimate': return '本地估算';
    default: return '未知';
  }
}

export function LlmSubscriptionsView() {
  const token = useStore((s) => s.token);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editKey, setEditKey] = useState('');

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const [r1, r2] = await Promise.all([
        fetch('/api/llm-subscriptions', { headers: { Authorization: `Bearer ${token}` } }),
        fetch('/api/llm-usage/summary', { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (r1.ok) {
        const data = await r1.json();
        setSubs(data.subscriptions || []);
      } else {
        setError(`订阅服务返回 ${r1.status}（检查 LLM_SUB_URL / LLM_SUB_SHARED_SECRET）`);
      }
      if (r2.ok) {
        setSummary(await r2.json());
      }
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  const saveSecret = useCallback(
    async (provider: string) => {
      if (!editKey) return;
      try {
        const r = await fetch(`/api/llm-subscriptions/${provider}/secret`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: editKey }),
        });
        if (r.ok) {
          setEditing(null);
          setEditKey('');
          refresh();
        }
      } catch {
        // ignore
      }
    },
    [editKey, token, refresh],
  );

  const providers = useMemo(() => subs.map((s) => s.provider), [subs]);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>LLM 订阅</h1>
        <p className={styles.subtitle}>
          监视所有 LLM 订阅的登录状态和剩余用量。数据来自{' '}
          <code>llm-subscription-service</code>（默认 127.0.0.1:9101），通过 metabot 反代。
        </p>
      </div>

      <div className={styles.toolbar}>
        <span className={styles.toolbarLeft}>{subs.length} providers · 最近刷新 {loading ? '…' : '✓'}</span>
        <button className={styles.btn} onClick={refresh} disabled={loading}>
          {loading ? '…' : '刷新'}
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.providerGrid}>
        {subs.map((s) => (
          <div key={s.provider} className={styles.providerCard}>
            <div className={styles.providerHead}>
              <span className={styles.providerName}>{s.displayName}</span>
              <span className={s.loggedIn ? styles.statusOk : styles.statusBad}>
                {s.loggedIn ? '● 已登录' : '○ 未登录'}
              </span>
            </div>

            <div className={styles.providerMeta}>
              {s.account && <div>账号：{s.account}</div>}
              {s.plan && <div>套餐：{s.plan}</div>}
              {s.quotaWindow && <div>窗口：{s.quotaWindow}</div>}
              <div className={styles.confidence}>来源：{confidenceLabel(s.sourceConfidence)}</div>
            </div>

            {s.quotaUsedPct !== undefined && (
              <div className={styles.quotaBar}>
                <div className={styles.quotaTrack}>
                  <div
                    className={styles.quotaFill}
                    style={{ width: `${Math.min(100, s.quotaUsedPct)}%`, background: pctBarColor(s.quotaUsedPct) }}
                  />
                </div>
                <span className={styles.quotaLabel}>已用 {s.quotaUsedPct}%</span>
              </div>
            )}

            {s.quotaUsedRaw && !s.quotaUsedPct && (
              <pre className={styles.quotaRaw}>{s.quotaUsedRaw}</pre>
            )}

            {s.errors && s.errors.length > 0 && (
              <div className={styles.errorList}>
                {s.errors.map((e, i) => (
                  <div key={i}>⚠ {e}</div>
                ))}
              </div>
            )}

            <div className={styles.actions}>
              {s.authMode === 'api_key' && (
                editing === s.provider ? (
                  <>
                    <input
                      type="password"
                      placeholder="API key"
                      value={editKey}
                      onChange={(e) => setEditKey(e.target.value)}
                      className={styles.input}
                    />
                    <button className={styles.btn} onClick={() => saveSecret(s.provider)}>保存</button>
                    <button className={styles.btnGhost} onClick={() => { setEditing(null); setEditKey(''); }}>取消</button>
                  </>
                ) : (
                  <button className={styles.btn} onClick={() => setEditing(s.provider)}>
                    {s.loggedIn ? '更新 API key' : '配置 API key'}
                  </button>
                )
              )}
              {s.authMode === 'subscription_cli' && (
                <span className={styles.cliHint}>
                  CLI 登录：在 metabot 主机上跑 <code>{s.provider === 'anthropic' ? 'claude login' : 'codex login'}</code>
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className={styles.summarySection}>
        <h2 className={styles.h2}>metabot 自家用量（30 天）</h2>
        {summary && Object.keys(summary.byProvider).length > 0 ? (
          <table className={styles.summaryTable}>
            <thead>
              <tr>
                <th>Provider</th>
                <th>调用次数</th>
                <th>tokens in</th>
                <th>tokens out</th>
                <th>cost (USD)</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => {
                const row = summary.byProvider[p];
                if (!row) return null;
                return (
                  <tr key={p}>
                    <td>{p}</td>
                    <td>{row.calls}</td>
                    <td>{row.tokensIn.toLocaleString()}</td>
                    <td>{row.tokensOut.toLocaleString()}</td>
                    <td>{row.costUsd.toFixed(4)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className={styles.empty}>暂无用量记录。metabot 每次 LLM 调用后会推一条记录到本面板。</div>
        )}
      </div>
    </div>
  );
}
