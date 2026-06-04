# Quota Auto-Resume Watcher

When a Claude / OpenAI / DeepSeek / Kimi / Qwen / MiniMax call comes back with
a usage-limit / rate-limit error, MetaBot enrolls the user's prompt with the
**QuotaResumeManager** and re-fires it automatically once the provider's
quota window resets.

The retry is scheduled at `unlock_time + 2 minutes`, not `unlock_time` itself.
The 2-minute buffer (`QUOTA_RESUME_BUFFER_MS`) compensates for clock skew
between the local server and the provider edge — without it, firing exactly
at the parsed unlock instant tends to produce another 429 because the
provider's quota counter has not yet propagated.

## How it works

1. `executeApiTask` in `MessageBridge` finishes a run that ended in an error
   state.
2. `isUsageLimitError(lastState.errorMessage)` (regex match against common
   provider phrases — see `src/bridge/quota-watcher.ts`) returns true.
3. The bridge calls `quotaResume.enroll(...)` with:
   - `prompt` — the original user message
   - `chatId` — same as the failed turn
   - `errorMessage` — passed to `parseResetTime` to find the unlock instant
4. `parseResetTime` extracts a time from the error string. Supported forms:
   - ISO 8601 (`2026-06-04T18:00:00Z`)
   - `retry after N seconds / minutes / hours`
   - bare `HH:MM` after "try again at" / "resets at"
   - bare Unix timestamps (10- or 13-digit)
5. `computeScheduledRetry` adds the 2-minute buffer and clamps to
   `[5 min, 24 h]` so we never spin-retry and never wait absurdly long.
6. The bridge appends a footer to the user's error card so they see when
   the auto-retry will fire:

   > ⏰ 已检测用量超限。解锁时间 `06-04 14:30` + 2 分钟缓冲，将于
   > `06-04 14:32` 自动重新执行。

7. When the timer fires, the manager calls `executeApiTask` again with
   `userId='quota-resume'` (so we don't re-enroll on a second consecutive
   failure → guards against infinite loops). A blue "⏰ 自动续跑" notice
   card lets the user know.

## Persistence

Entries are written to `~/.metabot/quota-resume-<botName>.json` after every
mutation. On bridge startup, pending entries are restored. Entries whose
`scheduledRetryAt` already passed during downtime fire ~1s after restore so
the system catches up rather than skipping the user's request.

Completed / failed entries are kept on disk for 7 days for ops visibility,
then pruned.

## Configuration

There are no env knobs — the behavior is on by default and the 2-minute
buffer is non-configurable (intentional: it was added to fix a recurring
race; making it tunable invites people to set it to 0 and rediscover the
race).

If you need to disable auto-resume for a specific bot, the simplest path is
to wrap the bridge with an `isUsageLimitError` shim that always returns
false, but that's a code-level opt-out, not a config flag.

## Observability

- Per-bot `MessageBridge.listPendingQuotaResumes()` exposes the pending
  queue. Wire it to a route if you want to display it in the management UI.
- `~/.metabot/quota-resume-<botName>.json` is human-readable.
- Logs:
  - `Quota resume enrolled` — when the watcher catches an error and queues
    a retry.
  - `Quota resume firing scheduled retry` — when the timer pops and the
    callback runs.
  - `Quota resume: chat busy at fire time, re-enrolling for +5min` — when
    the user has another task in flight and we punt.
