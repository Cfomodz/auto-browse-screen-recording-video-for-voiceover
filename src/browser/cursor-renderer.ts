import { Page } from 'puppeteer-core';
import { CursorConfig, CursorEvent, ClickButtonType } from '../core/types';
import { Logger } from '../utils/logger';

/**
 * Default cursor configuration — used when `cursor` is omitted from PipelineConfig.
 */
export const DEFAULT_CURSOR_CONFIG: CursorConfig = {
  enabled: true,
  size: 20,
  color: 'rgba(0, 0, 0, 0.85)',
  clickEffect: {
    enabled: true,
    downScale: 0.85,
    downDurationMs: 40,
    releaseOvershoot: 1.08,
    releaseDurationMs: 180,
  },
  rippleEffect: {
    enabled: true,
    ringCount: 2,
    maxRadius: 40,
    durationMs: 400,
    staggerMs: 80,
    color: 'rgba(66, 133, 244, 0.6)',
    strokeWidth: 2,
  },
  restingJitter: {
    enabled: true,
    amplitude: 1.5,
    frequency: 0.8,
  },
};

/**
 * Shape of the click-effect config passed into the browser context.
 * Mirrors CursorConfig['clickEffect'] but avoids importing DOM types.
 */
interface ClickEffectParams {
  enabled: boolean;
  downScale: number;
  downDurationMs: number;
  releaseOvershoot: number;
  releaseDurationMs: number;
}

/** Shape of the ripple-effect config passed into the browser context. */
interface RippleEffectParams {
  enabled: boolean;
  ringCount: number;
  maxRadius: number;
  durationMs: number;
  staggerMs: number;
  color: string;
  strokeWidth: number;
}

/** Shape of the resting-jitter config passed into the browser context. */
interface JitterParams {
  enabled: boolean;
  amplitude: number;
  frequency: number;
}

/**
 * CursorRenderer — injects a synthetic cursor overlay into the browser page.
 *
 * Because we're recording via CDP screencast, the OS cursor is not captured.
 * This class renders a cursor element with CSS-driven animations directly
 * in the DOM so it appears in every captured frame.
 *
 * Features:
 *  1. **Cursor Path Creator** — The cursor element moves via CSS translate,
 *     positioned by the MouseAnimator Bézier path. Resting jitter uses
 *     Perlin-like value noise to add micro-movements when idle.
 *
 *  2. **Click Scaling** — On mousedown the cursor shrinks (squash), on
 *     mouseup it springs back with overshoot using CSS keyframe animations
 *     with spring physics.
 *
 *  3. **Ripple / Ring Effect** — Expanding, fading concentric circles emitted
 *     from the click origin to draw the viewer's eye.
 */
export class CursorRenderer {
  private config: CursorConfig;
  private logger: Logger;
  private injected = false;

  /** Accumulated cursor events during the current recording clip. */
  private _events: CursorEvent[] = [];
  private _clipStartTime = 0;

  constructor(config: CursorConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /** Start tracking cursor events for a new clip. */
  startClipTracking(clipStartTime: number): void {
    this._events = [];
    this._clipStartTime = clipStartTime;
  }

  /** Collect all cursor events accumulated during the current clip. */
  collectEvents(): CursorEvent[] {
    return [...this._events];
  }

  /** Record a cursor event. */
  private recordEvent(type: CursorEvent['type'], x: number, y: number, clickType?: ClickButtonType): void {
    const timeOffset = (Date.now() - this._clipStartTime) / 1000;
    this._events.push({ timeOffset, type, x, y, clickType });
  }

  /**
   * Build the browser-side JavaScript source that creates the synthetic
   * cursor overlay, animations, and public API on `window.__syntheticCursor`.
   *
   * This is injected as a string via `page.evaluateOnNewDocument` so that
   * TypeScript does not try to type-check browser-only DOM globals.
   */
  private buildBrowserScript(): string {
    const cfg = this.config;
    const ce = cfg.clickEffect;
    const re = cfg.rippleEffect;
    const rj = cfg.restingJitter;

    return `(function(){
      // ────────────────────── Cursor Element ──────────────────────
      function ensureCursorElement() {
        var el = document.getElementById('__synthetic_cursor');
        if (el) return el;

        el = document.createElement('div');
        el.id = '__synthetic_cursor';
        el.style.cssText =
          'position:fixed;top:0;left:0;' +
          'width:${cfg.size}px;height:${cfg.size}px;' +
          'border-radius:50%;background:${cfg.color};' +
          'pointer-events:none;z-index:2147483647;' +
          'transform:translate(-50%,-50%);transition:none;' +
          'will-change:transform;box-shadow:0 1px 3px rgba(0,0,0,0.3);';
        document.documentElement.appendChild(el);

        var style = document.createElement('style');
        style.id = '__synthetic_cursor_styles';
        style.textContent =
          '@keyframes __cursor_click_down{' +
            '0%{transform:translate(-50%,-50%) scale(1)}' +
            '100%{transform:translate(-50%,-50%) scale(${ce.downScale})}}' +
          '@keyframes __cursor_click_release{' +
            '0%{transform:translate(-50%,-50%) scale(${ce.downScale})}' +
            '50%{transform:translate(-50%,-50%) scale(${ce.releaseOvershoot})}' +
            '100%{transform:translate(-50%,-50%) scale(1)}}' +
          '@keyframes __cursor_ripple_expand{' +
            '0%{transform:translate(-50%,-50%) scale(0);opacity:1}' +
            '100%{transform:translate(-50%,-50%) scale(1);opacity:0}}';
        document.documentElement.appendChild(style);
        return el;
      }

      // ────────────────── Resting Jitter (value noise) ──────────────────
      var _jitterSeed = Math.random() * 1000;
      function valueNoise(t) {
        var i = Math.floor(t);
        var f = t - i;
        var u = f * f * (3 - 2 * f);
        var a = Math.sin(i * 127.1 + _jitterSeed) * 43758.5453;
        var b = Math.sin((i + 1) * 127.1 + _jitterSeed) * 43758.5453;
        return (a - Math.floor(a)) * (1 - u) + (b - Math.floor(b)) * u;
      }

      // ────────────────── State ──────────────────
      var curX = 0, curY = 0;
      var isResting = false, restStartTime = 0, jitterRafId = null;

      var jitterEnabled = ${rj.enabled};
      var jitterAmplitude = ${rj.amplitude};
      var jitterFrequency = ${rj.frequency};
      var clickEnabled = ${ce.enabled};
      var clickDownMs = ${ce.downDurationMs};
      var clickReleaseMs = ${ce.releaseDurationMs};
      var rippleEnabled = ${re.enabled};
      var rippleRingCount = ${re.ringCount};
      var rippleMaxRadius = ${re.maxRadius};
      var rippleDurationMs = ${re.durationMs};
      var rippleStaggerMs = ${re.staggerMs};
      var rippleColor = '${re.color}';
      var rippleStrokeWidth = ${re.strokeWidth};

      // ────────────────── Public API ──────────────────
      window.__syntheticCursor = {
        moveTo: function(x, y) {
          curX = x; curY = y;
          isResting = false;
          if (jitterRafId !== null) { cancelAnimationFrame(jitterRafId); jitterRafId = null; }
          var el = ensureCursorElement();
          el.style.left = x + 'px';
          el.style.top = y + 'px';
          el.style.transform = 'translate(-50%,-50%) scale(1)';
        },

        startResting: function() {
          if (!jitterEnabled || isResting) return;
          isResting = true;
          restStartTime = performance.now();
          _jitterSeed = Math.random() * 1000;

          function jitterLoop() {
            if (!isResting) return;
            var t = (performance.now() - restStartTime) / 1000 * jitterFrequency;
            var dx = (valueNoise(t) - 0.5) * 2 * jitterAmplitude;
            var dy = (valueNoise(t + 100) - 0.5) * 2 * jitterAmplitude;
            var el = ensureCursorElement();
            el.style.left = (curX + dx) + 'px';
            el.style.top = (curY + dy) + 'px';
            jitterRafId = requestAnimationFrame(jitterLoop);
          }
          jitterLoop();
        },

        stopResting: function() {
          isResting = false;
          if (jitterRafId !== null) { cancelAnimationFrame(jitterRafId); jitterRafId = null; }
          var el = ensureCursorElement();
          el.style.left = curX + 'px';
          el.style.top = curY + 'px';
        },

        triggerClick: function(x, y) {
          var el = ensureCursorElement();

          if (clickEnabled) {
            el.style.animation = 'none';
            void el.offsetWidth; // force reflow
            el.style.animation =
              '__cursor_click_down ' + clickDownMs + 'ms ease-out forwards';
            setTimeout(function() {
              el.style.animation =
                '__cursor_click_release ' + clickReleaseMs + 'ms cubic-bezier(0.34,1.56,0.64,1) forwards';
            }, clickDownMs);
          }

          if (rippleEnabled) {
            for (var i = 0; i < rippleRingCount; i++) {
              (function(idx) {
                setTimeout(function() {
                  var ring = document.createElement('div');
                  ring.style.cssText =
                    'position:fixed;left:' + x + 'px;top:' + y + 'px;' +
                    'width:' + (rippleMaxRadius * 2) + 'px;height:' + (rippleMaxRadius * 2) + 'px;' +
                    'border-radius:50%;border:' + rippleStrokeWidth + 'px solid ' + rippleColor + ';' +
                    'background:transparent;pointer-events:none;z-index:2147483646;' +
                    'transform:translate(-50%,-50%) scale(0);' +
                    'animation:__cursor_ripple_expand ' + rippleDurationMs + 'ms ease-out forwards;';
                  document.documentElement.appendChild(ring);
                  setTimeout(function() { ring.remove(); }, rippleDurationMs + 50);
                }, idx * rippleStaggerMs);
              })(i);
            }
          }
        },

        hide: function() {
          var el = document.getElementById('__synthetic_cursor');
          if (el) el.style.display = 'none';
        },

        show: function() {
          var el = ensureCursorElement();
          el.style.display = '';
        }
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { ensureCursorElement(); });
      } else {
        ensureCursorElement();
      }
    })();`;
  }

  /**
   * Inject the cursor overlay element + animation styles into the page.
   * Uses `evaluateOnNewDocument` so the cursor is created on every navigation.
   */
  async inject(page: Page): Promise<void> {
    if (!this.config.enabled) return;

    const script = this.buildBrowserScript();
    await page.evaluateOnNewDocument(script);

    this.injected = true;
    this.logger.info('Cursor renderer injected into page.');
  }

  /**
   * Ensure the cursor element exists on the current page.
   * Call after navigation to re-create if the page was replaced.
   */
  async ensureOnPage(page: Page): Promise<void> {
    if (!this.config.enabled) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.evaluate(() => {
      const api = (globalThis as any).__syntheticCursor;
      if (api) api.show();
    });
  }

  /**
   * Move the synthetic cursor to a position.
   * Called by MouseAnimator on each Bézier step so the overlay tracks the path.
   */
  async moveTo(page: Page, x: number, y: number): Promise<void> {
    if (!this.config.enabled) return;
    this.recordEvent('move', x, y);
    await page.evaluate((px: number, py: number) => {
      const api = (globalThis as any).__syntheticCursor;
      if (api) api.moveTo(px, py);
    }, x, y);
  }

  /**
   * Start resting jitter at the current position.
   * Called after mouse arrives at target and before a pause.
   */
  async startResting(page: Page, x: number, y: number): Promise<void> {
    if (!this.config.enabled || !this.config.restingJitter.enabled) return;
    this.recordEvent('rest-start', x, y);
    await page.evaluate(() => {
      const api = (globalThis as any).__syntheticCursor;
      if (api) api.startResting();
    });
  }

  /**
   * Stop resting jitter.
   */
  async stopResting(page: Page): Promise<void> {
    if (!this.config.enabled || !this.config.restingJitter.enabled) return;
    this.recordEvent('rest-end', 0, 0);
    await page.evaluate(() => {
      const api = (globalThis as any).__syntheticCursor;
      if (api) api.stopResting();
    });
  }

  /**
   * Trigger click visual effects at (x, y).
   * Called by MouseAnimator.moveAndClick() alongside SFX.
   */
  async triggerClick(page: Page, x: number, y: number, clickType: ClickButtonType = 'left'): Promise<void> {
    if (!this.config.enabled) return;
    this.recordEvent('click', x, y, clickType);
    await page.evaluate((px: number, py: number) => {
      const api = (globalThis as any).__syntheticCursor;
      if (api) api.triggerClick(px, py);
    }, x, y);
  }

  /** Hide the cursor overlay (e.g. during non-interactive scenes). */
  async hide(page: Page): Promise<void> {
    if (!this.config.enabled) return;
    await page.evaluate(() => {
      const api = (globalThis as any).__syntheticCursor;
      if (api) api.hide();
    });
  }

  /** Show the cursor overlay. */
  async show(page: Page): Promise<void> {
    if (!this.config.enabled) return;
    await page.evaluate(() => {
      const api = (globalThis as any).__syntheticCursor;
      if (api) api.show();
    });
  }

  get isInjected(): boolean {
    return this.injected;
  }
}

/**
 * Resolve cursor config: merges user config with defaults.
 * Returns the effective CursorConfig, or a disabled stub if cursor is off.
 */
export function resolveCursorConfig(userConfig?: CursorConfig): CursorConfig {
  if (!userConfig) return DEFAULT_CURSOR_CONFIG;
  if (!userConfig.enabled) return { ...DEFAULT_CURSOR_CONFIG, enabled: false };

  return {
    ...DEFAULT_CURSOR_CONFIG,
    ...userConfig,
    clickEffect: { ...DEFAULT_CURSOR_CONFIG.clickEffect, ...userConfig.clickEffect },
    rippleEffect: { ...DEFAULT_CURSOR_CONFIG.rippleEffect, ...userConfig.rippleEffect },
    restingJitter: { ...DEFAULT_CURSOR_CONFIG.restingJitter, ...userConfig.restingJitter },
  };
}
