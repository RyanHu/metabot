import { describe, it, expect } from 'vitest';
import { rewriteEffortXhigh } from '../src/api/routes/volcengine-relay-routes.js';

/**
 * M5.5-E regression — Claude Code emits `output_config.effort: "xhigh"` on
 * the Opus reasoning ladder, but 火山 ark's Anthropic-compat gateway only
 * accepts `low|medium|high|max`. The relay's job is to rewrite that single
 * field in-place before forwarding. Pin the rewrite shape so any future
 * refactor can't silently re-introduce the 400.
 */
describe('rewriteEffortXhigh — volcengine relay body transform', () => {
  it('rewrites top-level effort=xhigh to max', () => {
    const body: any = { effort: 'xhigh' };
    rewriteEffortXhigh(body);
    expect(body.effort).toBe('max');
  });

  it('rewrites nested effort under output_config (the actual upstream shape)', () => {
    const body: any = {
      model: 'deepseek-v4-pro',
      output_config: { effort: 'xhigh' },
      messages: [{ role: 'user', content: 'hi' }],
    };
    rewriteEffortXhigh(body);
    expect(body.output_config.effort).toBe('max');
    expect(body.model).toBe('deepseek-v4-pro');
  });

  it('does NOT touch valid effort values', () => {
    const body: any = { output_config: { effort: 'high' } };
    rewriteEffortXhigh(body);
    expect(body.output_config.effort).toBe('high');
  });

  it('walks arrays', () => {
    const body: any = {
      items: [{ effort: 'xhigh' }, { effort: 'medium' }],
    };
    rewriteEffortXhigh(body);
    expect(body.items[0].effort).toBe('max');
    expect(body.items[1].effort).toBe('medium');
  });

  it('leaves bodies without effort alone', () => {
    const body: any = {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const snapshot = JSON.stringify(body);
    rewriteEffortXhigh(body);
    expect(JSON.stringify(body)).toBe(snapshot);
  });

  it('does not blow up on null / primitives', () => {
    expect(() => rewriteEffortXhigh(null)).not.toThrow();
    expect(() => rewriteEffortXhigh('hello')).not.toThrow();
    expect(() => rewriteEffortXhigh(42)).not.toThrow();
    expect(() => rewriteEffortXhigh(undefined)).not.toThrow();
  });

  it('does not match a key spelled differently (e.g. "Effort")', () => {
    const body: any = { Effort: 'xhigh' };
    rewriteEffortXhigh(body);
    expect(body.Effort).toBe('xhigh');
  });
});
