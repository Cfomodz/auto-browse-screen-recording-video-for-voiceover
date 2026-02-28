import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CursorRenderer, resolveCursorConfig, DEFAULT_CURSOR_CONFIG } from '../../src/browser/cursor-renderer';
import { CursorConfig } from '../../src/core/types';
import { createLogger } from '../../src/utils/logger';

const logger = createLogger('test');
logger.silent = true;

// ─── resolveCursorConfig ─────────────────────────────────────────────────────

describe('resolveCursorConfig', () => {
  it('returns default config when no user config is provided', () => {
    const resolved = resolveCursorConfig();
    expect(resolved).toEqual(DEFAULT_CURSOR_CONFIG);
    expect(resolved.enabled).toBe(true);
  });

  it('returns disabled config when user sets enabled: false', () => {
    const resolved = resolveCursorConfig({ enabled: false } as CursorConfig);
    expect(resolved.enabled).toBe(false);
  });

  it('merges top-level fields from user config', () => {
    const resolved = resolveCursorConfig({
      ...DEFAULT_CURSOR_CONFIG,
      size: 32,
      color: 'red',
    });
    expect(resolved.size).toBe(32);
    expect(resolved.color).toBe('red');
    // Sub-objects should still have defaults
    expect(resolved.clickEffect.downScale).toBe(DEFAULT_CURSOR_CONFIG.clickEffect.downScale);
  });

  it('merges clickEffect sub-object', () => {
    const resolved = resolveCursorConfig({
      ...DEFAULT_CURSOR_CONFIG,
      clickEffect: {
        ...DEFAULT_CURSOR_CONFIG.clickEffect,
        downScale: 0.7,
      },
    });
    expect(resolved.clickEffect.downScale).toBe(0.7);
    expect(resolved.clickEffect.releaseDurationMs).toBe(
      DEFAULT_CURSOR_CONFIG.clickEffect.releaseDurationMs
    );
  });

  it('merges rippleEffect sub-object', () => {
    const resolved = resolveCursorConfig({
      ...DEFAULT_CURSOR_CONFIG,
      rippleEffect: {
        ...DEFAULT_CURSOR_CONFIG.rippleEffect,
        ringCount: 5,
        maxRadius: 100,
      },
    });
    expect(resolved.rippleEffect.ringCount).toBe(5);
    expect(resolved.rippleEffect.maxRadius).toBe(100);
    expect(resolved.rippleEffect.strokeWidth).toBe(
      DEFAULT_CURSOR_CONFIG.rippleEffect.strokeWidth
    );
  });

  it('merges restingJitter sub-object', () => {
    const resolved = resolveCursorConfig({
      ...DEFAULT_CURSOR_CONFIG,
      restingJitter: {
        ...DEFAULT_CURSOR_CONFIG.restingJitter,
        amplitude: 3.0,
      },
    });
    expect(resolved.restingJitter.amplitude).toBe(3.0);
    expect(resolved.restingJitter.frequency).toBe(
      DEFAULT_CURSOR_CONFIG.restingJitter.frequency
    );
  });
});

// ─── DEFAULT_CURSOR_CONFIG ───────────────────────────────────────────────────

describe('DEFAULT_CURSOR_CONFIG', () => {
  it('has all required fields', () => {
    expect(DEFAULT_CURSOR_CONFIG.enabled).toBe(true);
    expect(DEFAULT_CURSOR_CONFIG.size).toBeGreaterThan(0);
    expect(DEFAULT_CURSOR_CONFIG.color).toBeTruthy();
    expect(DEFAULT_CURSOR_CONFIG.clickEffect).toBeDefined();
    expect(DEFAULT_CURSOR_CONFIG.rippleEffect).toBeDefined();
    expect(DEFAULT_CURSOR_CONFIG.restingJitter).toBeDefined();
  });

  it('click effect has valid spring physics values', () => {
    const ce = DEFAULT_CURSOR_CONFIG.clickEffect;
    expect(ce.downScale).toBeGreaterThan(0);
    expect(ce.downScale).toBeLessThan(1); // shrinks, doesn't grow
    expect(ce.releaseOvershoot).toBeGreaterThan(1); // overshoots past 100%
    expect(ce.downDurationMs).toBeGreaterThan(0);
    expect(ce.releaseDurationMs).toBeGreaterThan(ce.downDurationMs); // release is slower
  });

  it('ripple effect has valid expansion values', () => {
    const re = DEFAULT_CURSOR_CONFIG.rippleEffect;
    expect(re.ringCount).toBeGreaterThanOrEqual(1);
    expect(re.maxRadius).toBeGreaterThan(0);
    expect(re.durationMs).toBeGreaterThan(0);
    expect(re.strokeWidth).toBeGreaterThan(0);
  });

  it('resting jitter has valid noise parameters', () => {
    const rj = DEFAULT_CURSOR_CONFIG.restingJitter;
    expect(rj.amplitude).toBeGreaterThan(0);
    expect(rj.amplitude).toBeLessThan(10); // subtle, not wild
    expect(rj.frequency).toBeGreaterThan(0);
    expect(rj.frequency).toBeLessThan(5); // smooth, not seizure
  });
});

// ─── CursorRenderer ─────────────────────────────────────────────────────────

describe('CursorRenderer', () => {
  describe('event tracking', () => {
    let renderer: CursorRenderer;

    beforeEach(() => {
      renderer = new CursorRenderer(DEFAULT_CURSOR_CONFIG, logger);
    });

    it('starts with empty events', () => {
      renderer.startClipTracking(Date.now());
      expect(renderer.collectEvents()).toEqual([]);
    });

    it('does not inject when disabled', async () => {
      const disabledRenderer = new CursorRenderer(
        { ...DEFAULT_CURSOR_CONFIG, enabled: false },
        logger
      );
      const mockPage = { evaluateOnNewDocument: vi.fn() } as any;
      await disabledRenderer.inject(mockPage);
      expect(mockPage.evaluateOnNewDocument).not.toHaveBeenCalled();
      expect(disabledRenderer.isInjected).toBe(false);
    });

    it('records move events with correct coordinates', async () => {
      renderer.startClipTracking(Date.now());
      const mockPage = {
        evaluate: vi.fn().mockResolvedValue(undefined),
      } as any;

      await renderer.moveTo(mockPage, 100, 200);
      await renderer.moveTo(mockPage, 300, 400);

      const events = renderer.collectEvents();
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('move');
      expect(events[0].x).toBe(100);
      expect(events[0].y).toBe(200);
      expect(events[1].type).toBe('move');
      expect(events[1].x).toBe(300);
      expect(events[1].y).toBe(400);
    });

    it('records click events with click type', async () => {
      renderer.startClipTracking(Date.now());
      const mockPage = {
        evaluate: vi.fn().mockResolvedValue(undefined),
      } as any;

      await renderer.triggerClick(mockPage, 500, 600, 'left');
      await renderer.triggerClick(mockPage, 700, 800, 'right');

      const events = renderer.collectEvents();
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('click');
      expect(events[0].clickType).toBe('left');
      expect(events[1].type).toBe('click');
      expect(events[1].clickType).toBe('right');
    });

    it('records rest-start and rest-end events', async () => {
      renderer.startClipTracking(Date.now());
      const mockPage = {
        evaluate: vi.fn().mockResolvedValue(undefined),
      } as any;

      await renderer.startResting(mockPage, 150, 250);
      await renderer.stopResting(mockPage);

      const events = renderer.collectEvents();
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('rest-start');
      expect(events[0].x).toBe(150);
      expect(events[0].y).toBe(250);
      expect(events[1].type).toBe('rest-end');
    });

    it('event timeOffset increases over time', async () => {
      renderer.startClipTracking(Date.now() - 1000); // started 1s ago
      const mockPage = {
        evaluate: vi.fn().mockResolvedValue(undefined),
      } as any;

      await renderer.moveTo(mockPage, 10, 20);

      const events = renderer.collectEvents();
      expect(events[0].timeOffset).toBeGreaterThanOrEqual(1.0);
    });

    it('collectEvents returns a copy, not a reference', async () => {
      renderer.startClipTracking(Date.now());
      const mockPage = {
        evaluate: vi.fn().mockResolvedValue(undefined),
      } as any;

      await renderer.moveTo(mockPage, 10, 20);
      const events1 = renderer.collectEvents();
      await renderer.moveTo(mockPage, 30, 40);
      const events2 = renderer.collectEvents();

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(2);
    });

    it('startClipTracking resets events', async () => {
      renderer.startClipTracking(Date.now());
      const mockPage = {
        evaluate: vi.fn().mockResolvedValue(undefined),
      } as any;

      await renderer.moveTo(mockPage, 10, 20);
      expect(renderer.collectEvents()).toHaveLength(1);

      renderer.startClipTracking(Date.now());
      expect(renderer.collectEvents()).toHaveLength(0);
    });
  });

  describe('disabled renderer skips all page calls', () => {
    it('moveTo does nothing when disabled', async () => {
      const renderer = new CursorRenderer(
        { ...DEFAULT_CURSOR_CONFIG, enabled: false },
        logger
      );
      const mockPage = { evaluate: vi.fn() } as any;
      await renderer.moveTo(mockPage, 100, 200);
      expect(mockPage.evaluate).not.toHaveBeenCalled();
    });

    it('triggerClick does nothing when disabled', async () => {
      const renderer = new CursorRenderer(
        { ...DEFAULT_CURSOR_CONFIG, enabled: false },
        logger
      );
      const mockPage = { evaluate: vi.fn() } as any;
      await renderer.triggerClick(mockPage, 100, 200);
      expect(mockPage.evaluate).not.toHaveBeenCalled();
    });

    it('startResting does nothing when jitter is disabled', async () => {
      const renderer = new CursorRenderer(
        {
          ...DEFAULT_CURSOR_CONFIG,
          restingJitter: { ...DEFAULT_CURSOR_CONFIG.restingJitter, enabled: false },
        },
        logger
      );
      const mockPage = { evaluate: vi.fn() } as any;
      await renderer.startResting(mockPage, 100, 200);
      expect(mockPage.evaluate).not.toHaveBeenCalled();
    });

    it('hide and show call page.evaluate when enabled', async () => {
      const renderer = new CursorRenderer(DEFAULT_CURSOR_CONFIG, logger);
      const mockPage = { evaluate: vi.fn().mockResolvedValue(undefined) } as any;
      await renderer.hide(mockPage);
      expect(mockPage.evaluate).toHaveBeenCalledTimes(1);
      await renderer.show(mockPage);
      expect(mockPage.evaluate).toHaveBeenCalledTimes(2);
    });
  });

  describe('inject', () => {
    it('calls evaluateOnNewDocument with browser script', async () => {
      const renderer = new CursorRenderer(DEFAULT_CURSOR_CONFIG, logger);
      const mockPage = {
        evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
      } as any;

      await renderer.inject(mockPage);

      expect(mockPage.evaluateOnNewDocument).toHaveBeenCalledTimes(1);
      expect(renderer.isInjected).toBe(true);

      // The script should contain key cursor config values
      const script = mockPage.evaluateOnNewDocument.mock.calls[0][0];
      expect(typeof script).toBe('string');
      expect(script).toContain('__synthetic_cursor');
      expect(script).toContain(String(DEFAULT_CURSOR_CONFIG.size));
      expect(script).toContain(DEFAULT_CURSOR_CONFIG.color);
      expect(script).toContain(String(DEFAULT_CURSOR_CONFIG.clickEffect.downScale));
      expect(script).toContain(String(DEFAULT_CURSOR_CONFIG.rippleEffect.maxRadius));
      expect(script).toContain(String(DEFAULT_CURSOR_CONFIG.restingJitter.amplitude));
    });

    it('browser script contains all effect implementations', async () => {
      const renderer = new CursorRenderer(DEFAULT_CURSOR_CONFIG, logger);
      const mockPage = {
        evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
      } as any;

      await renderer.inject(mockPage);
      const script = mockPage.evaluateOnNewDocument.mock.calls[0][0] as string;

      // Cursor path creator: moveTo function
      expect(script).toContain('moveTo');
      // Click scaling: animation keyframes
      expect(script).toContain('__cursor_click_down');
      expect(script).toContain('__cursor_click_release');
      expect(script).toContain('cubic-bezier');
      // Ripple effect: ring expansion animation
      expect(script).toContain('__cursor_ripple_expand');
      expect(script).toContain('rippleRingCount');
      // Resting jitter: value noise function
      expect(script).toContain('valueNoise');
      expect(script).toContain('jitterLoop');
      expect(script).toContain('requestAnimationFrame');
    });
  });
});
