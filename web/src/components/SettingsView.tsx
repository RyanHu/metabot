import { useState, useCallback, useEffect } from 'react';
import { useStore } from '../store';
import type { BotInfo } from '../types';
import { BotManageDialog } from './BotManageDialog';
import styles from './SettingsView.module.css';

interface QuotaResumeEntry {
  id: string;
  botName: string;
  chatId: string;
  prompt: string;
  unlockTime: number;
  scheduledRetryAt: number;
  errorSnippet?: string;
  createdAt: number;
  attempts: number;
}

function formatTime(t: number): string {
  return new Date(t).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** LiteLLM Admin UI base. Defaults to the studio host's port-61050 instance;
 *  override at build time with VITE_LITELLM_URL for other deployments. */
const LITELLM_URL =
  (import.meta as any).env?.VITE_LITELLM_URL ?? 'http://192.168.50.14:61050/ui';

export function SettingsView() {
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const fontSize = useStore((s) => s.fontSize);
  const setFontSize = useStore((s) => s.setFontSize);
  const token = useStore((s) => s.token);
  const logout = useStore((s) => s.logout);
  const connected = useStore((s) => s.connected);
  const bots = useStore((s) => s.bots);
  const sessions = useStore((s) => s.sessions);
  const clearSessions = useStore((s) => s.clearSessions);

  const [dialogMode, setDialogMode] = useState<'create' | 'edit' | null>(null);
  const [editBot, setEditBot] = useState<BotInfo | undefined>();

  const [quotaResumes, setQuotaResumes] = useState<QuotaResumeEntry[]>([]);
  const [quotaLoading, setQuotaLoading] = useState(false);

  const refreshQuotaResumes = useCallback(async () => {
    if (!token) return;
    setQuotaLoading(true);
    try {
      const r = await fetch('/api/quota-resumes', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        const data = await r.json();
        setQuotaResumes(data.entries || []);
      }
    } catch {
      // ignore — show empty
    } finally {
      setQuotaLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refreshQuotaResumes();
    const id = setInterval(refreshQuotaResumes, 30_000);
    return () => clearInterval(id);
  }, [refreshQuotaResumes]);

  const handleCancelQuotaResume = useCallback(
    async (botName: string, entryId: string) => {
      if (!window.confirm(`取消该 bot "${botName}" 的待续跑任务？取消后不会再自动重发。`)) return;
      try {
        await fetch(
          `/api/quota-resumes/${encodeURIComponent(botName)}/${encodeURIComponent(entryId)}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
        );
        await refreshQuotaResumes();
      } catch {
        // ignore
      }
    },
    [token, refreshQuotaResumes],
  );

  const handleCreateBot = useCallback(() => {
    setEditBot(undefined);
    setDialogMode('create');
  }, []);

  const handleEditBot = useCallback((bot: BotInfo) => {
    setEditBot(bot);
    setDialogMode('edit');
  }, []);

  const handleDeleteBot = useCallback(async (botName: string) => {
    if (!window.confirm(`Delete bot "${botName}"? This cannot be undone.`)) return;
    try {
      await fetch(`/api/bots/${encodeURIComponent(botName)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // ignore — bot list will update via WS
    }
  }, [token]);

  const maskedToken = token
    ? `${token.slice(0, 6)}${'*'.repeat(Math.min(token.length - 6, 20))}`
    : 'Not set';

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Settings</h1>
        <p className={styles.subtitle}>
          Manage your MetaBot configuration and preferences.
        </p>
      </div>

      {/* Appearance */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Appearance</h2>
        <div className={styles.card}>
          <div className={styles.cardItem}>
            <div className={styles.cardItemLeft}>
              <span className={styles.cardItemLabel}>Dark Mode</span>
              <span className={styles.cardItemDesc}>
                Toggle between dark and light themes
              </span>
            </div>
            <button
              className={`${styles.toggle} ${
                theme === 'dark' ? styles.toggleOn : ''
              }`}
              onClick={toggleTheme}
              aria-label="Toggle theme"
            />
          </div>

          <div className={styles.cardItem}>
            <div className={styles.cardItemLeft}>
              <span className={styles.cardItemLabel}>Font Size</span>
              <span className={styles.cardItemDesc}>
                Adjust text size for readability
              </span>
            </div>
            <div className={styles.fontSizeGroup}>
              {(['small', 'normal', 'large', 'xl'] as const).map((size) => (
                <button
                  key={size}
                  className={`${styles.fontSizeBtn} ${
                    fontSize === size ? styles.fontSizeBtnActive : ''
                  }`}
                  onClick={() => setFontSize(size)}
                >
                  {{ small: 'S', normal: 'M', large: 'L', xl: 'XL' }[size]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Connection */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Connection</h2>
        <div className={styles.card}>
          <div className={styles.cardItem}>
            <div className={styles.cardItemLeft}>
              <span className={styles.cardItemLabel}>Status</span>
              <span className={styles.cardItemDesc}>
                WebSocket connection to MetaBot server
              </span>
            </div>
            <span
              className={`${styles.connBadge} ${
                connected ? styles.connBadgeOnline : styles.connBadgeOffline
              }`}
            >
              <span
                className={`${styles.connDot} ${
                  connected ? styles.connDotOn : styles.connDotOff
                }`}
              />
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>

          <div className={styles.cardItem}>
            <div className={styles.cardItemLeft}>
              <span className={styles.cardItemLabel}>API Token</span>
              <span className={styles.cardItemDesc}>{maskedToken}</span>
            </div>
            <button
              className={`${styles.btn} ${styles.btnOutline}`}
              onClick={logout}
            >
              Disconnect
            </button>
          </div>
        </div>
      </div>

      {/* Bots */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>
            Bots ({bots.length})
          </h2>
          <button
            className={`${styles.btn} ${styles.btnAccent}`}
            onClick={handleCreateBot}
          >
            + Add Bot
          </button>
        </div>
        <div className={styles.card}>
          {bots.length === 0 ? (
            <div className={styles.cardItem}>
              <div className={styles.cardItemLeft}>
                <span className={styles.cardItemLabel}>No bots available</span>
                <span className={styles.cardItemDesc}>
                  {connected
                    ? 'No bots are configured on the server'
                    : 'Connect to see available bots'}
                </span>
              </div>
            </div>
          ) : (
            <div className={styles.botList}>
              {bots.map((bot) => (
                <div key={bot.name} className={styles.botItem}>
                  <span
                    className={`${styles.botDot} ${
                      connected ? styles.botDotOnline : styles.botDotOffline
                    }`}
                  />
                  <div className={styles.botInfo}>
                    <div className={styles.botName}>{bot.name}</div>
                    <div className={styles.botMeta}>
                      {bot.platform} &middot; {bot.workingDirectory}
                    </div>
                    {bot.description && (
                      <div
                        className={styles.cardItemDesc}
                        style={{ marginTop: '2px' }}
                      >
                        {bot.description}
                      </div>
                    )}
                  </div>
                  <div className={styles.botActions}>
                    <button
                      className={`${styles.btn} ${styles.btnSmall} ${styles.btnOutline}`}
                      onClick={() => handleEditBot(bot)}
                    >
                      Edit
                    </button>
                    <button
                      className={`${styles.btn} ${styles.btnSmall} ${styles.btnDanger}`}
                      onClick={() => handleDeleteBot(bot.name)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* LLM Routing — LiteLLM Admin */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>LLM Routing</h2>
        <div className={styles.card}>
          <div className={styles.cardItem}>
            <div className={styles.cardItemLeft}>
              <span className={styles.cardItemLabel}>LiteLLM Admin Console</span>
              <span className={styles.cardItemDesc}>
                Model registry, virtual keys, usage dashboard &middot; {LITELLM_URL}
              </span>
            </div>
            <a
              className={`${styles.btn} ${styles.btnOutline}`}
              href={LITELLM_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open ↗
            </a>
          </div>
        </div>
      </div>

      {/* Pending quota auto-resumes */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>
            Pending Quota Auto-Resumes ({quotaResumes.length})
          </h2>
          <button
            className={`${styles.btn} ${styles.btnSmall} ${styles.btnOutline}`}
            onClick={refreshQuotaResumes}
            disabled={quotaLoading}
          >
            {quotaLoading ? '…' : 'Refresh'}
          </button>
        </div>
        <div className={styles.card}>
          {quotaResumes.length === 0 ? (
            <div className={styles.cardItem}>
              <div className={styles.cardItemLeft}>
                <span className={styles.cardItemLabel}>No pending resumes</span>
                <span className={styles.cardItemDesc}>
                  Tasks that hit a usage limit will auto-retry at unlock_time + 2 min buffer and appear here.
                </span>
              </div>
            </div>
          ) : (
            <div className={styles.quotaList}>
              {quotaResumes.map((e) => (
                <div key={e.id} className={styles.quotaItem}>
                  <div className={styles.quotaInfo}>
                    <div className={styles.quotaTop}>
                      <span className={styles.quotaBotTag}>{e.botName}</span>
                      <span>{e.chatId}</span>
                    </div>
                    <div className={styles.quotaPrompt} title={e.prompt}>
                      "{e.prompt}"
                    </div>
                    <div className={styles.quotaMeta}>
                      unlock {formatTime(e.unlockTime)} &middot; fires {formatTime(e.scheduledRetryAt)}
                      {e.attempts > 0 ? ` · attempts ${e.attempts}` : ''}
                    </div>
                  </div>
                  <button
                    className={`${styles.btn} ${styles.btnSmall} ${styles.btnDanger}`}
                    onClick={() => handleCancelQuotaResume(e.botName, e.id)}
                  >
                    Cancel
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Data */}
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Data</h2>
        <div className={styles.card}>
          <div className={styles.cardItem}>
            <div className={styles.cardItemLeft}>
              <span className={styles.cardItemLabel}>Chat History</span>
              <span className={styles.cardItemDesc}>
                {sessions.size} conversation{sessions.size !== 1 ? 's' : ''}{' '}
                stored locally
              </span>
            </div>
            <button
              className={`${styles.btn} ${styles.btnDanger}`}
              onClick={() => {
                if (
                  window.confirm(
                    'Clear all conversations? This cannot be undone.',
                  )
                ) {
                  clearSessions();
                }
              }}
            >
              Clear All
            </button>
          </div>
        </div>
      </div>

      {/* Version */}
      <div className={styles.version}>
        MetaBot Web &middot; Built with{' '}
        <a
          href="https://github.com/anthropics/claude-code"
          target="_blank"
          rel="noopener noreferrer"
        >
          Claude Code
        </a>
      </div>

      {/* Bot manage dialog */}
      {dialogMode && (
        <BotManageDialog
          mode={dialogMode}
          bot={editBot}
          onClose={() => setDialogMode(null)}
        />
      )}
    </div>
  );
}
