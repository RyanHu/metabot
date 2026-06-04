import type * as http from 'node:http';
import { jsonResponse, readBody } from './helpers.js';
import type { RouteContext } from './types.js';

/**
 * M5.5 — Reverse-proxy to llm-subscription-service (port 9101 by default).
 *
 *   GET    /api/llm-subscriptions                  forwarded to service
 *   GET    /api/llm-subscriptions/:provider        ...
 *   POST   /api/llm-subscriptions/:provider/secret { apiKey, extra }
 *   GET    /api/llm-models
 *   POST   /api/llm-models                         upsert
 *   DELETE /api/llm-models/:id
 *   GET    /api/llm-usage?since&provider&limit
 *   POST   /api/llm-usage                          metabot bridges push per-call records
 *   GET    /api/llm-usage/summary
 *
 * Configure with LLM_SUB_URL + LLM_SUB_SHARED_SECRET in metabot's env.
 */

const SERVICE_URL = process.env.LLM_SUB_URL ?? 'http://127.0.0.1:9101';
const SHARED_SECRET = process.env.LLM_SUB_SHARED_SECRET;

type Forwardable = { method: string; subPath: string; body?: string };

function pickRoute(method: string, url: string): Forwardable | null {
  const u = url.split('?')[0];

  if (u === '/api/llm-subscriptions' && method === 'GET') {
    return { method, subPath: '/subscriptions' };
  }
  const subMatch = /^\/api\/llm-subscriptions\/([^/]+)(\/secret)?$/.exec(u);
  if (subMatch) {
    const provider = subMatch[1];
    const tail = subMatch[2] ? '/secret' : '';
    return { method, subPath: `/subscriptions/${encodeURIComponent(provider)}${tail}` };
  }

  if (u === '/api/llm-models' && (method === 'GET' || method === 'POST')) {
    return { method, subPath: '/models' };
  }
  const modelDel = /^\/api\/llm-models\/([^/]+)$/.exec(u);
  if (modelDel && method === 'DELETE') {
    return { method, subPath: `/models/${encodeURIComponent(modelDel[1])}` };
  }

  if (u === '/api/llm-usage' && (method === 'GET' || method === 'POST')) {
    const qs = url.includes('?') ? '?' + url.split('?')[1] : '';
    return { method, subPath: `/usage${qs}` };
  }
  if (u === '/api/llm-usage/summary' && method === 'GET') {
    return { method, subPath: '/usage/summary' };
  }

  return null;
}

export async function handleLlmSubscriptionsRoutes(
  _ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const target = pickRoute(method, url);
  if (!target) return false;

  let body: string | undefined;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    body = await readBody(req);
  }

  const headers: Record<string, string> = {};
  if (SHARED_SECRET) headers['Authorization'] = `Bearer ${SHARED_SECRET}`;
  if (body !== undefined) headers['Content-Type'] = req.headers['content-type'] ?? 'application/json';

  try {
    const upstream = await fetch(`${SERVICE_URL}${target.subPath}`, {
      method: target.method,
      headers,
      body: body !== undefined ? body : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const text = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/json');
    res.end(text);
  } catch (err: any) {
    jsonResponse(res, 502, {
      error: 'llm-subscription-service unreachable',
      detail: String(err?.message ?? err),
      serviceUrl: SERVICE_URL,
    });
  }
  return true;
}
