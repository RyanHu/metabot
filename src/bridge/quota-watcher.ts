import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';

/**
 * 2-minute safety buffer applied on top of the parsed unlock time before
 * we re-fire the original task. Avoids clock-skew failures where local
 * time has ticked past the unlock instant but the provider's quota
 * counter has not yet reset (Anthropic/OpenAI reset is eventually
 * consistent across their edge — re-firing exactly at the reset instant
 * frequently produces another 429).
 */
export const QUOTA_RESUME_BUFFER_MS = 120_000;

/**
 * Lower bound for any scheduled retry — even if the parser can't find
 * an unlock time, we don't want to spin-retry; wait at least this long.
 */
const MIN_RESUME_DELAY_MS = 5 * 60 * 1000;

/**
 * Upper bound — if a provider tells us to wait more than this, cap the
 * schedule so the user can re-issue manually. Anthropic monthly resets
 * can be 30 days away; we don't want a stale prompt firing then.
 */
const MAX_RESUME_DELAY_MS = 24 * 60 * 60 * 1000;

const PERSIST_DIR = path.join(os.homedir(), '.metabot');

export interface QuotaResumeEntry {
  id: string;
  botName: string;
  chatId: string;
  prompt: string;
  sendCards: boolean;
  userId?: string;
  /** Unix ms — the unlock instant we parsed from the provider error (no buffer). */
  unlockTime: number;
  /** Unix ms — unlockTime + QUOTA_RESUME_BUFFER_MS. The timer fires here. */
  scheduledRetryAt: number;
  /** Short excerpt of the original error message, for ops debugging. */
  errorSnippet?: string;
  createdAt: number;
  status: 'pending' | 'firing' | 'completed' | 'failed' | 'cancelled';
  attempts: number;
}

/** Pattern matchers for "you're rate-limited" error strings from the providers we route. */
const USAGE_LIMIT_PATTERNS = [
  /usage[_\s]limit/i,
  /rate[_\s]limit(_error|ed|_exceeded)?/i,
  /quota[_\s](exceeded|exhausted)/i,
  /you('?ve| have) reached your.*(limit|quota)/i,
  /credit(s)?\s+(exhausted|depleted)/i,
  /insufficient[_\s]quota/i,
  /(too many requests|429)/i,
  /try again (at|after)/i,
  /please retry after/i,
];

export function isUsageLimitError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  return USAGE_LIMIT_PATTERNS.some((re) => re.test(errorMessage));
}

/**
 * Parse the unlock instant (Unix ms) out of a provider rate-limit message.
 * Returns null if we can't find anything — the caller falls back to a
 * MIN_RESUME_DELAY_MS retry.
 *
 * Recognised forms (most → least specific):
 *   - "resets at 2026-06-04T18:00:00Z"           ISO 8601
 *   - "Try again at 14:30"                       HH:MM (local) — today or tomorrow
 *   - "retry after 1234 seconds"                 relative seconds
 *   - "retry after 5 minutes"                    relative minutes
 *   - "retry-after: 60"                          HTTP header pattern
 *   - "unix timestamp 1717500000"                bare unix seconds in body
 */
export function parseResetTime(errorMessage: string, now: number = Date.now()): number | null {
  if (!errorMessage) return null;

  // ISO 8601 / RFC 3339
  const iso = errorMessage.match(/\b(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\b/);
  if (iso) {
    const t = Date.parse(iso[1].replace(' ', 'T'));
    if (!Number.isNaN(t) && t > now) return t;
  }

  // Relative seconds
  const sec = errorMessage.match(/(?:retry[\s-]?after|try again (?:in|after)|wait)\s*[:=]?\s*(\d+)\s*(?:s|sec|secs|second|seconds)/i);
  if (sec) {
    const n = parseInt(sec[1], 10);
    if (n > 0) return now + n * 1000;
  }

  // Relative minutes
  const min = errorMessage.match(/(?:retry[\s-]?after|try again (?:in|after)|wait)\s*[:=]?\s*(\d+)\s*(?:m|min|mins|minute|minutes)/i);
  if (min) {
    const n = parseInt(min[1], 10);
    if (n > 0) return now + n * 60_000;
  }

  // Relative hours
  const hr = errorMessage.match(/(?:retry[\s-]?after|try again (?:in|after)|wait)\s*[:=]?\s*(\d+)\s*(?:h|hr|hrs|hour|hours)/i);
  if (hr) {
    const n = parseInt(hr[1], 10);
    if (n > 0) return now + n * 3_600_000;
  }

  // Bare HH:MM (assume next occurrence in local tz)
  const hm = errorMessage.match(/(?:try again|reset(?:s|s at|ting)?|available|unlocks?(?: at)?)\b[^0-9]{0,20}(\d{1,2}):(\d{2})\b/i);
  if (hm) {
    const h = parseInt(hm[1], 10);
    const m = parseInt(hm[2], 10);
    if (h < 24 && m < 60) {
      const target = new Date(now);
      target.setHours(h, m, 0, 0);
      let t = target.getTime();
      if (t <= now) t += 24 * 60 * 60 * 1000;
      return t;
    }
  }

  // Bare unix epoch (10 digits = seconds, 13 = ms)
  const unix = errorMessage.match(/\b(1[6-9]\d{8}|20\d{8}|1[6-9]\d{11}|20\d{11})\b/);
  if (unix) {
    const raw = unix[1];
    const t = raw.length === 13 ? parseInt(raw, 10) : parseInt(raw, 10) * 1000;
    if (t > now) return t;
  }

  return null;
}

/** Compute the actual scheduled retry instant, including buffer + clamps. */
export function computeScheduledRetry(
  errorMessage: string | undefined,
  now: number = Date.now(),
): { unlockTime: number; scheduledRetryAt: number } {
  const parsed = errorMessage ? parseResetTime(errorMessage, now) : null;
  const unlockTime = parsed ?? now + MIN_RESUME_DELAY_MS;
  let scheduledRetryAt = unlockTime + QUOTA_RESUME_BUFFER_MS;
  if (scheduledRetryAt - now < MIN_RESUME_DELAY_MS) scheduledRetryAt = now + MIN_RESUME_DELAY_MS;
  if (scheduledRetryAt - now > MAX_RESUME_DELAY_MS) scheduledRetryAt = now + MAX_RESUME_DELAY_MS;
  return { unlockTime, scheduledRetryAt };
}

/** Callback the bridge gives us so we can fire the prompt when the timer pops. */
export type QuotaResumeFire = (entry: QuotaResumeEntry) => Promise<void>;

/**
 * Per-bot manager. One instance per MessageBridge. Persists pending entries
 * to ~/.metabot/quota-resume-<botName>.json so they survive PM2 restarts.
 *
 * Why bot-scoped instead of process-scoped: each bot may use a different
 * provider (one bot on Claude Max OAuth, another on a virtual key with its
 * own daily budget) — quota events are bot-local, retry should be too.
 */
export class QuotaResumeManager {
  private entries = new Map<string, QuotaResumeEntry>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly persistFile: string;

  constructor(
    private readonly botName: string,
    private readonly logger: Logger,
    private readonly fire: QuotaResumeFire,
  ) {
    this.persistFile = path.join(PERSIST_DIR, `quota-resume-${sanitize(botName)}.json`);
    this.loadFromDisk();
  }

  enroll(input: {
    chatId: string;
    prompt: string;
    sendCards: boolean;
    userId?: string;
    errorMessage?: string;
  }): QuotaResumeEntry {
    // De-dupe: if there's already a pending entry for this chatId, replace it.
    // The latest user prompt is the one they'd actually want re-fired.
    for (const existing of this.entries.values()) {
      if (existing.chatId === input.chatId && existing.status === 'pending') {
        this.cancel(existing.id);
      }
    }

    const now = Date.now();
    const { unlockTime, scheduledRetryAt } = computeScheduledRetry(input.errorMessage, now);
    const entry: QuotaResumeEntry = {
      id: crypto.randomUUID(),
      botName: this.botName,
      chatId: input.chatId,
      prompt: input.prompt,
      sendCards: input.sendCards,
      userId: input.userId,
      unlockTime,
      scheduledRetryAt,
      errorSnippet: input.errorMessage?.slice(0, 300),
      createdAt: now,
      status: 'pending',
      attempts: 0,
    };
    this.entries.set(entry.id, entry);
    this.setTimer(entry);
    this.saveToDisk();

    this.logger.info(
      {
        botName: this.botName,
        chatId: input.chatId,
        unlockTime: new Date(unlockTime).toISOString(),
        scheduledRetryAt: new Date(scheduledRetryAt).toISOString(),
        bufferMs: QUOTA_RESUME_BUFFER_MS,
      },
      'Quota resume enrolled — auto-retry scheduled with 2-min buffer past unlock',
    );

    return entry;
  }

  cancel(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.status !== 'pending') return false;
    entry.status = 'cancelled';
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
    this.saveToDisk();
    this.logger.info({ botName: this.botName, id, chatId: entry.chatId }, 'Quota resume cancelled');
    return true;
  }

  /** All pending entries (cancelled / completed pruned). For /api/quota observability. */
  list(): QuotaResumeEntry[] {
    return Array.from(this.entries.values()).filter((e) => e.status === 'pending');
  }

  pendingCount(): number {
    return this.list().length;
  }

  destroy(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.saveToDisk();
  }

  private setTimer(entry: QuotaResumeEntry): void {
    const delay = Math.max(0, entry.scheduledRetryAt - Date.now());
    // setTimeout max ~24.8 days; we already cap at 24h so this is safe.
    const t = setTimeout(() => this.fireEntry(entry.id), delay);
    this.timers.set(entry.id, t);
  }

  private async fireEntry(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.status !== 'pending') return;

    this.timers.delete(id);
    entry.status = 'firing';
    entry.attempts += 1;
    this.saveToDisk();

    this.logger.info(
      { botName: this.botName, id, chatId: entry.chatId, attempts: entry.attempts },
      'Quota resume firing scheduled retry',
    );

    try {
      await this.fire(entry);
      entry.status = 'completed';
    } catch (err) {
      this.logger.error({ err, botName: this.botName, id }, 'Quota resume fire threw');
      entry.status = 'failed';
    }
    this.saveToDisk();
  }

  private saveToDisk(): void {
    try {
      fs.mkdirSync(PERSIST_DIR, { recursive: true });
      // Keep completed/failed entries for 7 days for ops visibility.
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const kept = Array.from(this.entries.values()).filter(
        (e) => e.status === 'pending' || e.createdAt > cutoff,
      );
      fs.writeFileSync(this.persistFile, JSON.stringify({ entries: kept }, null, 2));
    } catch (err) {
      this.logger.error({ err, botName: this.botName }, 'Failed to persist quota resume entries');
    }
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.persistFile)) return;
      const raw = fs.readFileSync(this.persistFile, 'utf-8');
      const data = JSON.parse(raw) as { entries?: QuotaResumeEntry[] };
      const entries = data.entries || [];
      const now = Date.now();
      for (const e of entries) {
        this.entries.set(e.id, e);
        if (e.status !== 'pending') continue;
        // If the scheduled time already passed during downtime, re-fire
        // immediately (still respecting the 2-min buffer that's already
        // baked into scheduledRetryAt). If the unlock time itself is still
        // in the future, keep the original schedule.
        if (e.scheduledRetryAt <= now) {
          // Fire as soon as the event loop is free, not synchronously, so
          // the bridge constructor finishes wiring before we kick a task.
          setTimeout(() => this.fireEntry(e.id), 1_000);
        } else {
          this.setTimer(e);
        }
      }
      const restored = this.list().length;
      if (restored > 0) {
        this.logger.info({ botName: this.botName, restored }, 'Restored quota resume entries from disk');
      }
    } catch (err) {
      this.logger.error({ err, botName: this.botName }, 'Failed to load quota resume entries');
    }
  }
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}
