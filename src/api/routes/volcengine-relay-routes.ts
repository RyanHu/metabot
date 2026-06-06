import type * as http from 'node:http';
import { Readable } from 'node:stream';
import { jsonResponse, readBody } from './helpers.js';
import type { RouteContext } from './types.js';

/**
 * Anthropic-protocol relay for 火山引擎 Coding Plan (M5.5-E).
 *
 * Why this exists
 * ---------------
 * Claude Code (the SDK subprocess MetaBot spawns) emits
 * `output_config.effort: "xhigh"` for the Opus-4.x reasoning ladder.
 * 火山 ark's Anthropic-compat gateway only accepts `low|medium|high|max`,
 * so any 棉花 turn that goes straight to ark returns:
 *
 *   400 The parameter output_config.effort specified in the request are
 *       not valid: expected low, medium, high or max, but got xhigh
 *
 * Point the bot's `provider.baseUrl` at this relay instead of ark directly,
 * and the relay walks the JSON body to rewrite `xhigh` → `max` before it
 * hands the request to ark. Streaming SSE responses are piped back
 * unchanged.
 *
 * Endpoint
 * --------
 *   POST /api/relay/volcengine-anthropic/v1/messages
 *   POST /api/relay/volcengine-anthropic/v1/messages?beta=...      (any tail)
 *
 * Configure the bot with:
 *   provider.baseUrl = "http://127.0.0.1:9100/api/relay/volcengine-anthropic"
 *   provider.apiKey  = "<ark AK>"
 *
 * Claude CLI will then call BASE_URL/v1/messages with x-api-key = <ark AK>,
 * which the relay forwards verbatim.
 *
 * Security
 * --------
 * Bound to localhost-only request sources by remoteAddress check. The
 * Anthropic auth check in the parent HTTP server is bypassed for this
 * path (Claude CLI doesn't know our Bearer secret), so the loopback gate
 * is the ONLY thing keeping a public attacker from burning the user's
 * 火山 quota. Don't loosen.
 */

const ARK_UPSTREAM_BASE =
  process.env.METABOT_VOLCENGINE_RELAY_UPSTREAM ?? 'https://ark.cn-beijing.volces.com/api/coding';
const ROUTE_PREFIX = '/api/relay/volcengine-anthropic';

/**
 * Recursively walk a parsed JSON tree, rewriting any string value `xhigh`
 * under a key named `effort` to `max`. Mutates in place for simplicity;
 * the caller doesn't reuse the input.
 *
 * Exported for unit tests.
 */
export function rewriteEffortXhigh(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) rewriteEffortXhigh(item);
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'effort' && v === 'xhigh') {
        obj[k] = 'max';
      } else if (typeof v === 'object' && v !== null) {
        rewriteEffortXhigh(v);
      }
    }
  }
}

function isLoopback(remote: string | undefined): boolean {
  if (!remote) return false;
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

export async function handleVolcengineRelayRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  if (!url.startsWith(ROUTE_PREFIX)) return false;

  // Loopback-only — the parent server's Bearer-secret check is bypassed
  // for /api/relay/* (see http-server.ts auth guard), so this is the
  // only thing protecting the upstream API key. Treat any non-loopback
  // request as an attack: short-circuit with 403 and log.
  const remote = req.socket.remoteAddress;
  if (!isLoopback(remote)) {
    ctx.logger.warn({ remote, url }, 'volcengine-relay: rejecting non-loopback request');
    jsonResponse(res, 403, { error: 'forbidden (loopback only)' });
    return true;
  }

  if (method !== 'POST') {
    jsonResponse(res, 405, { error: 'method not allowed' });
    return true;
  }

  // /api/relay/volcengine-anthropic/v1/messages → /v1/messages
  const tail = url.slice(ROUTE_PREFIX.length) || '/';
  const upstreamUrl = `${ARK_UPSTREAM_BASE}${tail}`;

  let bodyRaw: string;
  try {
    bodyRaw = await readBody(req);
  } catch (err: any) {
    jsonResponse(res, err?.statusCode ?? 400, { error: err?.message ?? 'read body failed' });
    return true;
  }

  let bodyJson: unknown;
  try {
    bodyJson = JSON.parse(bodyRaw);
  } catch {
    jsonResponse(res, 400, { error: 'request body is not valid JSON' });
    return true;
  }

  rewriteEffortXhigh(bodyJson);
  const rewritten = JSON.stringify(bodyJson);

  // Forward only the headers the upstream cares about. In particular keep
  // x-api-key / authorization / anthropic-version / accept (for SSE).
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  for (const name of ['x-api-key', 'authorization', 'anthropic-version', 'anthropic-beta', 'accept']) {
    const v = req.headers[name];
    if (typeof v === 'string') headers[name] = v;
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: rewritten,
      // Claude CLI streams long turns — no client-side timeout, let the
      // SDK manage it.
    });
  } catch (err: any) {
    ctx.logger.error({ err, upstreamUrl }, 'volcengine-relay: upstream fetch failed');
    jsonResponse(res, 502, { error: 'upstream unreachable', detail: String(err?.message ?? err) });
    return true;
  }

  res.statusCode = upstream.status;
  upstream.headers.forEach((value, key) => {
    if (['connection', 'keep-alive', 'transfer-encoding'].includes(key.toLowerCase())) return;
    try { res.setHeader(key, value); } catch { /* ignore unsettable */ }
  });

  if (upstream.body) {
    const nodeStream = Readable.fromWeb(upstream.body as any);
    nodeStream.on('error', (err) => {
      ctx.logger.warn({ err }, 'volcengine-relay: stream error');
      try { res.end(); } catch { /* */ }
    });
    nodeStream.pipe(res);
  } else {
    res.end();
  }
  return true;
}
