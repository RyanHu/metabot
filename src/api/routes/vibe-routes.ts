import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as http from 'node:http';
import { jsonResponse } from './helpers.js';
import type { RouteContext } from './types.js';

/**
 * M5 — Vibe-coding pipeline observability.
 *
 *   GET /api/vibe/projects                  list every pipeline.json under PROJECTS_ROOT
 *   GET /api/vibe/projects/:slug            full pipeline + per-phase artifact list
 *   GET /api/vibe/projects/:slug/file/<f>   read a single artifact (00-requirement.md etc.)
 *
 * Source of truth is the filesystem under /opt/workspace/ai-studio-knowledge/projects.
 * The /vibe skill writes pipeline.json + the artifact files; this route is read-only.
 * Override the root with VIBE_PROJECTS_ROOT for tests / other deployments.
 */

const PROJECTS_ROOT =
  process.env.VIBE_PROJECTS_ROOT ?? '/opt/workspace/ai-studio-knowledge/projects';

interface PipelineFile {
  slug: string;
  requirement?: string;
  createdAt?: string;
  updatedAt?: string;
  currentPhase?: string;
  phases?: Record<string, { status?: string; startedAt?: string; completedAt?: string; error?: string; prUrl?: string }>;
  status?: string;
}

function safeReadPipeline(slug: string): PipelineFile | null {
  const file = path.join(PROJECTS_ROOT, slug, 'pipeline.json');
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw) as PipelineFile;
  } catch {
    return null;
  }
}

function listSlugs(): string[] {
  try {
    return fs
      .readdirSync(PROJECTS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function listArtifacts(slug: string): string[] {
  const base = path.join(PROJECTS_ROOT, slug);
  const out: string[] = [];
  const walk = (sub: string) => {
    const full = path.join(base, sub);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(full, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.isFile() && rel !== 'pipeline.json') out.push(rel);
    }
  };
  walk('');
  return out.sort();
}

export async function handleVibeRoutes(
  ctx: RouteContext,
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  if (method !== 'GET' || !url.startsWith('/api/vibe/')) return false;

  // GET /api/vibe/projects
  if (url === '/api/vibe/projects') {
    const out = listSlugs()
      .map((slug) => safeReadPipeline(slug))
      .filter((p): p is PipelineFile => p !== null)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    jsonResponse(res, 200, { root: PROJECTS_ROOT, count: out.length, projects: out });
    return true;
  }

  // GET /api/vibe/projects/:slug/file/<filename>
  const fileMatch = url.match(/^\/api\/vibe\/projects\/([^/]+)\/file\/(.+)$/);
  if (fileMatch) {
    const slug = decodeURIComponent(fileMatch[1]);
    const rel = decodeURIComponent(fileMatch[2]);
    // Defence in depth: reject anything that tries to escape the project dir.
    if (rel.includes('..') || rel.startsWith('/')) {
      jsonResponse(res, 400, { error: 'Invalid file path' });
      return true;
    }
    const full = path.join(PROJECTS_ROOT, slug, rel);
    if (!full.startsWith(path.join(PROJECTS_ROOT, slug) + path.sep)) {
      jsonResponse(res, 400, { error: 'Invalid file path' });
      return true;
    }
    try {
      const content = fs.readFileSync(full, 'utf-8');
      const stat = fs.statSync(full);
      jsonResponse(res, 200, { slug, path: rel, size: stat.size, content });
    } catch (err) {
      ctx.logger.debug({ err, slug, rel }, 'vibe file read failed');
      jsonResponse(res, 404, { error: 'Artifact not found' });
    }
    return true;
  }

  // GET /api/vibe/projects/:slug
  const slugMatch = url.match(/^\/api\/vibe\/projects\/([^/]+)$/);
  if (slugMatch) {
    const slug = decodeURIComponent(slugMatch[1]);
    const pipeline = safeReadPipeline(slug);
    if (!pipeline) {
      jsonResponse(res, 404, { error: 'Pipeline not found' });
      return true;
    }
    jsonResponse(res, 200, { pipeline, artifacts: listArtifacts(slug) });
    return true;
  }

  return false;
}
