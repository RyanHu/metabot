import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store';
import styles from './VibeView.module.css';

interface PhaseStatus {
  status?: 'pending' | 'running' | 'done' | 'failed';
  startedAt?: string;
  completedAt?: string;
  error?: string;
  prUrl?: string;
}

interface Pipeline {
  slug: string;
  requirement?: string;
  createdAt?: string;
  updatedAt?: string;
  currentPhase?: string;
  status?: string;
  phases?: Record<string, PhaseStatus>;
}

const PHASE_ORDER = [
  'requirement',
  'design',
  'design_review',
  'implementation',
  'code_review',
];

const PHASE_LABELS: Record<string, string> = {
  requirement: '需求',
  design: '设计',
  design_review: '设计评审',
  implementation: '编码',
  code_review: '代码评审',
};

function statusClass(s?: string): string {
  if (s === 'done') return styles.phaseDone;
  if (s === 'running') return styles.phaseRunning;
  if (s === 'failed') return styles.phaseFailed;
  return styles.phasePending;
}

function statusGlyph(s?: string): string {
  if (s === 'done') return '✅';
  if (s === 'running') return '⏳';
  if (s === 'failed') return '❌';
  return '○';
}

function formatTime(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function VibeView() {
  const token = useStore((s) => s.token);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [root, setRoot] = useState('');
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [artifacts, setArtifacts] = useState<Map<string, string[]>>(new Map());
  const [modalContent, setModalContent] = useState<{ title: string; body: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch('/api/vibe/projects', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        const data = await r.json();
        setPipelines(data.projects || []);
        setRoot(data.root || '');
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  const toggleExpand = useCallback(
    async (slug: string) => {
      const next = new Set(expanded);
      if (next.has(slug)) {
        next.delete(slug);
        setExpanded(next);
        return;
      }
      next.add(slug);
      setExpanded(next);
      if (!artifacts.has(slug)) {
        try {
          const r = await fetch(`/api/vibe/projects/${encodeURIComponent(slug)}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (r.ok) {
            const data = await r.json();
            setArtifacts((prev) => new Map(prev).set(slug, data.artifacts || []));
          }
        } catch {
          // ignore
        }
      }
    },
    [expanded, artifacts, token],
  );

  const openArtifact = useCallback(
    async (slug: string, file: string) => {
      try {
        const r = await fetch(
          `/api/vibe/projects/${encodeURIComponent(slug)}/file/${encodeURIComponent(file)}`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (r.ok) {
          const data = await r.json();
          setModalContent({ title: `${slug} / ${file}`, body: data.content || '' });
        }
      } catch {
        // ignore
      }
    },
    [token],
  );

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.title}>Vibe Coding Pipelines</h1>
        <p className={styles.subtitle}>
          Pipelines launched via the <code>/vibe</code> skill. Each row is a project under{' '}
          <code>{root || 'ai-studio-knowledge/projects/'}</code>.
        </p>
      </div>

      <div className={styles.toolbar}>
        <span className={styles.toolbarLeft}>{pipelines.length} pipelines</span>
        <button className={styles.btn} onClick={refresh} disabled={loading}>
          {loading ? '…' : 'Refresh'}
        </button>
      </div>

      {pipelines.length === 0 ? (
        <div className={styles.empty}>
          No pipelines yet. Start one in chat: <code>/vibe &lt;requirement&gt;</code>.
        </div>
      ) : (
        pipelines.map((p) => {
          const isOpen = expanded.has(p.slug);
          const files = artifacts.get(p.slug) || [];
          const prUrl = p.phases?.code_review?.prUrl;
          return (
            <div key={p.slug} className={styles.pipelineCard}>
              <div className={styles.pipelineHead} onClick={() => toggleExpand(p.slug)}>
                <span className={styles.slug}>{p.slug}</span>
                <span className={styles.updatedAt}>updated {formatTime(p.updatedAt)}</span>
              </div>
              {p.requirement && <div className={styles.requirement}>{p.requirement}</div>}
              <div className={styles.phases}>
                {PHASE_ORDER.map((key) => {
                  const ph = p.phases?.[key];
                  return (
                    <span key={key} className={`${styles.phase} ${statusClass(ph?.status)}`}>
                      <span>{statusGlyph(ph?.status)}</span>
                      <span>{PHASE_LABELS[key]}</span>
                    </span>
                  );
                })}
              </div>
              {prUrl && (
                <a className={styles.prLink} href={prUrl} target="_blank" rel="noopener noreferrer">
                  → {prUrl}
                </a>
              )}
              {isOpen && (
                <div className={styles.artifacts}>
                  {files.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--text-2)' }}>No artifacts yet.</div>
                  ) : (
                    <div className={styles.artifactList}>
                      {files.map((f) => (
                        <div
                          key={f}
                          className={styles.artifactItem}
                          onClick={() => openArtifact(p.slug, f)}
                        >
                          <span>{f}</span>
                          <span style={{ fontSize: 10, color: 'var(--text-2)' }}>view ↗</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}

      {modalContent && (
        <div className={styles.modalBackdrop} onClick={() => setModalContent(null)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <span className={styles.modalTitle}>{modalContent.title}</span>
              <button className={styles.btn} onClick={() => setModalContent(null)}>
                Close
              </button>
            </div>
            <div className={styles.modalBody}>{modalContent.body}</div>
          </div>
        </div>
      )}
    </div>
  );
}
