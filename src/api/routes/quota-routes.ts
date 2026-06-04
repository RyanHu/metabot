import type * as http from 'node:http';
import { jsonResponse } from './helpers.js';
import type { RouteContext } from './types.js';

/**
 * M4-D — observability + cancel for the quota auto-resume scheduler.
 *
 *   GET    /api/quota-resumes                       list pending across all bots
 *   DELETE /api/quota-resumes/:botName/:entryId     cancel a pending entry
 *
 * Auto-resume is a sticky guarantee: once enrolled, the prompt *will* re-fire
 * past unlock_time + 2-min buffer. Sometimes the user wants to abort (the
 * prompt is stale, the quota was bumped, they typed the same thing manually).
 * This route is that escape hatch.
 */
export async function handleQuotaRoutes(
  ctx: RouteContext,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  if (!url.startsWith('/api/quota-resumes')) return false;

  // GET /api/quota-resumes
  if (method === 'GET' && url === '/api/quota-resumes') {
    const out: Array<{
      id: string;
      botName: string;
      chatId: string;
      prompt: string;
      unlockTime: number;
      scheduledRetryAt: number;
      errorSnippet?: string;
      createdAt: number;
      attempts: number;
    }> = [];
    for (const bot of ctx.registry.listRegistered()) {
      const entries = bot.bridge.listPendingQuotaResumes?.() ?? [];
      for (const e of entries) {
        out.push({
          id: e.id,
          botName: e.botName,
          chatId: e.chatId,
          prompt: e.prompt,
          unlockTime: e.unlockTime,
          scheduledRetryAt: e.scheduledRetryAt,
          errorSnippet: e.errorSnippet,
          createdAt: e.createdAt,
          attempts: e.attempts,
        });
      }
    }
    out.sort((a, b) => a.scheduledRetryAt - b.scheduledRetryAt);
    jsonResponse(res, 200, { count: out.length, entries: out });
    return true;
  }

  // DELETE /api/quota-resumes/:botName/:entryId
  if (method === 'DELETE') {
    const m = url.match(/^\/api\/quota-resumes\/([^/]+)\/([^/]+)$/);
    if (m) {
      const botName = decodeURIComponent(m[1]);
      const entryId = decodeURIComponent(m[2]);
      const bot = ctx.registry.get(botName);
      if (!bot) {
        jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
        return true;
      }
      const cancelled = bot.bridge.cancelQuotaResume?.(entryId) ?? false;
      if (!cancelled) {
        jsonResponse(res, 404, { error: 'Quota resume entry not found or already fired' });
        return true;
      }
      ctx.logger.info({ botName, entryId }, 'Quota resume cancelled via API');
      jsonResponse(res, 200, { botName, entryId, cancelled: true });
      return true;
    }
  }

  return false;
}
