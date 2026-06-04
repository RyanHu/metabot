import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  QuotaResumeManager,
  isUsageLimitError,
  parseResetTime,
  computeScheduledRetry,
  QUOTA_RESUME_BUFFER_MS,
} from '../src/bridge/quota-watcher.js';
import type { Logger } from '../src/utils/logger.js';

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

describe('isUsageLimitError', () => {
  it('matches Anthropic rate-limit text', () => {
    expect(isUsageLimitError("You've reached your usage limit. Try again at 14:30.")).toBe(true);
    expect(isUsageLimitError('rate_limit_error: monthly quota exhausted')).toBe(true);
  });

  it('matches OpenAI / LiteLLM 429 text', () => {
    expect(isUsageLimitError('Error 429: too many requests. Please retry after 60 seconds.')).toBe(true);
    expect(isUsageLimitError('rate_limit_exceeded — please retry after 30s')).toBe(true);
  });

  it('matches credit / insufficient quota messages', () => {
    expect(isUsageLimitError('insufficient_quota')).toBe(true);
    expect(isUsageLimitError('Credits exhausted on your account')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isUsageLimitError('ECONNREFUSED 127.0.0.1:61050')).toBe(false);
    expect(isUsageLimitError('Session id invalid')).toBe(false);
    expect(isUsageLimitError(undefined)).toBe(false);
    expect(isUsageLimitError('')).toBe(false);
  });
});

describe('parseResetTime', () => {
  const NOW = Date.UTC(2026, 5, 4, 12, 0, 0); // 2026-06-04 12:00 UTC

  it('parses ISO 8601 timestamps', () => {
    const t = parseResetTime('Resets at 2026-06-04T18:00:00Z', NOW);
    expect(t).toBe(Date.UTC(2026, 5, 4, 18, 0, 0));
  });

  it('parses "retry after N seconds"', () => {
    const t = parseResetTime('Please retry after 90 seconds', NOW);
    expect(t).toBe(NOW + 90_000);
  });

  it('parses "retry after N minutes"', () => {
    const t = parseResetTime('Try again after 5 minutes', NOW);
    expect(t).toBe(NOW + 5 * 60_000);
  });

  it('parses "retry after N hours"', () => {
    const t = parseResetTime('Wait 2 hours', NOW);
    expect(t).toBe(NOW + 2 * 3_600_000);
  });

  it('parses bare HH:MM (today or tomorrow)', () => {
    const t = parseResetTime('Try again at 14:30', NOW);
    expect(t).not.toBeNull();
    expect(t!).toBeGreaterThan(NOW);
  });

  it('returns null for unparseable strings', () => {
    expect(parseResetTime('some random error', NOW)).toBeNull();
  });
});

describe('computeScheduledRetry', () => {
  const NOW = 1_700_000_000_000;

  it('adds the 2-minute buffer past unlock time', () => {
    const { unlockTime, scheduledRetryAt } = computeScheduledRetry(
      'retry after 600 seconds',
      NOW,
    );
    expect(unlockTime).toBe(NOW + 600_000);
    expect(scheduledRetryAt).toBe(NOW + 600_000 + QUOTA_RESUME_BUFFER_MS);
  });

  it('honors the minimum delay floor when parser fails', () => {
    const { scheduledRetryAt } = computeScheduledRetry('???', NOW);
    expect(scheduledRetryAt - NOW).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it('clamps absurdly long unlock windows to 24h', () => {
    const farFuture = 'retry after 999999 minutes';
    const { scheduledRetryAt } = computeScheduledRetry(farFuture, NOW);
    expect(scheduledRetryAt - NOW).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('the buffer constant is exactly 2 minutes', () => {
    expect(QUOTA_RESUME_BUFFER_MS).toBe(120_000);
  });
});

describe('QuotaResumeManager', () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-watcher-test-'));
    process.env.HOME = tmpDir;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalHome) process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enrolls a pending entry with 2-min buffer baked in', () => {
    const now = Date.now();
    const fire = vi.fn(async () => {});
    const mgr = new QuotaResumeManager('bot-a', noopLogger, fire);
    const entry = mgr.enroll({
      chatId: 'chat-1',
      prompt: 'do thing',
      sendCards: false,
      errorMessage: 'retry after 60 seconds',
    });
    expect(entry.status).toBe('pending');
    expect(entry.unlockTime).toBe(now + 60_000);
    // Min floor applies because unlock(+buffer = 180s) is below the 5-min floor.
    expect(entry.scheduledRetryAt - now).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(mgr.pendingCount()).toBe(1);
    mgr.destroy();
  });

  it('fires the callback at scheduledRetryAt', async () => {
    const fire = vi.fn(async () => {});
    const mgr = new QuotaResumeManager('bot-a', noopLogger, fire);
    mgr.enroll({
      chatId: 'chat-1',
      prompt: 'do thing',
      sendCards: false,
      errorMessage: 'retry after 600 seconds', // 10min + 2min buffer = 12min
    });
    expect(fire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(12 * 60 * 1000 + 1000);
    expect(fire).toHaveBeenCalledOnce();
    mgr.destroy();
  });

  it('replaces an existing pending entry for the same chatId', () => {
    const fire = vi.fn(async () => {});
    const mgr = new QuotaResumeManager('bot-a', noopLogger, fire);
    mgr.enroll({ chatId: 'chat-1', prompt: 'first', sendCards: false, errorMessage: 'retry after 600 seconds' });
    mgr.enroll({ chatId: 'chat-1', prompt: 'second', sendCards: false, errorMessage: 'retry after 800 seconds' });
    const pending = mgr.list();
    expect(pending).toHaveLength(1);
    expect(pending[0].prompt).toBe('second');
    mgr.destroy();
  });

  it('persists and restores pending entries across instances', () => {
    const fire1 = vi.fn(async () => {});
    const mgr1 = new QuotaResumeManager('bot-a', noopLogger, fire1);
    mgr1.enroll({ chatId: 'chat-1', prompt: 'persist me', sendCards: true, errorMessage: 'retry after 1200 seconds' });
    mgr1.destroy();

    const fire2 = vi.fn(async () => {});
    const mgr2 = new QuotaResumeManager('bot-a', noopLogger, fire2);
    expect(mgr2.list()).toHaveLength(1);
    expect(mgr2.list()[0].prompt).toBe('persist me');
    mgr2.destroy();
  });

  it('cancel() removes a pending timer', async () => {
    const fire = vi.fn(async () => {});
    const mgr = new QuotaResumeManager('bot-a', noopLogger, fire);
    const entry = mgr.enroll({ chatId: 'chat-1', prompt: 'x', sendCards: false, errorMessage: 'retry after 600 seconds' });
    expect(mgr.cancel(entry.id)).toBe(true);
    expect(mgr.pendingCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(fire).not.toHaveBeenCalled();
    mgr.destroy();
  });

  it('isolates entries per bot (separate persist files)', () => {
    const fireA = vi.fn(async () => {});
    const fireB = vi.fn(async () => {});
    const mgrA = new QuotaResumeManager('bot-a', noopLogger, fireA);
    const mgrB = new QuotaResumeManager('bot-b', noopLogger, fireB);
    mgrA.enroll({ chatId: 'chat-1', prompt: 'for-a', sendCards: false, errorMessage: 'retry after 600 seconds' });
    expect(mgrA.pendingCount()).toBe(1);
    expect(mgrB.pendingCount()).toBe(0);
    mgrA.destroy();
    mgrB.destroy();
  });
});
