import { Page } from 'puppeteer-core';
import { ScrollEvent } from '../core/types';
import { delay } from '../utils/timing';

/**
 * Realistic mouse movement using Bézier curves.
 *
 * Generates a smooth, human-like path between two points with slight
 * overshoot, variable speed, and natural-looking curvature.
 */
export class MouseAnimator {
  private page: Page;
  private currentX: number = 0;
  private currentY: number = 0;

  constructor(page: Page) {
    this.page = page;
  }

  /** Move the mouse to (x, y) with a realistic animated path. */
  async moveTo(x: number, y: number, durationMs: number = 600): Promise<void> {
    const steps = Math.max(20, Math.floor(durationMs / 16)); // ~60fps
    const points = this.generateBezierPath(
      this.currentX, this.currentY,
      x, y,
      steps
    );

    for (const point of points) {
      await this.page.mouse.move(point.x, point.y);
      await delay(durationMs / steps);
    }

    this.currentX = x;
    this.currentY = y;
  }

  /** Move to an element and click it with realistic timing. */
  async moveAndClick(
    x: number,
    y: number,
    options?: { durationMs?: number; pauseBeforeClick?: number }
  ): Promise<void> {
    const { durationMs = 600, pauseBeforeClick = 150 } = options ?? {};
    await this.moveTo(x, y, durationMs);
    // Brief human pause before clicking
    await delay(pauseBeforeClick + Math.random() * 100);
    await this.page.mouse.click(x, y);
  }

  /** Scroll down smoothly, simulating mouse wheel. */
  async smoothScroll(
    pixels: number,
    durationMs: number = 2000
  ): Promise<void> {
    const steps = Math.max(10, Math.floor(durationMs / 50));
    const perStep = pixels / steps;

    for (let i = 0; i < steps; i++) {
      // Vary scroll speed slightly for realism
      const jitter = 0.8 + Math.random() * 0.4;
      await this.page.mouse.wheel({ deltaY: perStep * jitter });
      await delay(durationMs / steps);
    }
  }

  /**
   * Replay recorded scroll events with their original timing.
   *
   * This is the scroll equivalent of TypingAnimator.typeWithAudioCadence():
   * the wheel events are fired at the exact millisecond offsets captured
   * during recording, so the visual scroll velocity and micro-pauses match
   * the trackpad gesture embedded in the paired audio clip.
   *
   * @param events           Ordered scroll events from a ScrollClipMeta
   * @param reverseDirection Negate all deltaY values (play a down clip as up)
   */
  async scrollWithAudioCadence(
    events: ScrollEvent[],
    reverseDirection: boolean = false
  ): Promise<void> {
    if (events.length === 0) return;
    const startTime = Date.now();

    for (const event of events) {
      const elapsed = Date.now() - startTime;
      const waitMs = Math.max(0, event.timestampMs - elapsed);
      if (waitMs > 0) await delay(waitMs);
      const deltaY = reverseDirection ? -event.deltaY : event.deltaY;
      await this.page.mouse.wheel({ deltaY });
    }
  }

  /**
   * Generate a cubic Bézier path between two points.
   * Control points are offset randomly to create natural-looking curves.
   */
  private generateBezierPath(
    x0: number, y0: number,
    x1: number, y1: number,
    steps: number
  ): Array<{ x: number; y: number }> {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const spread = dist * 0.3;

    // Random control points for the cubic Bézier
    const cp1x = x0 + (x1 - x0) * 0.25 + (Math.random() - 0.5) * spread;
    const cp1y = y0 + (y1 - y0) * 0.25 + (Math.random() - 0.5) * spread;
    const cp2x = x0 + (x1 - x0) * 0.75 + (Math.random() - 0.5) * spread;
    const cp2y = y0 + (y1 - y0) * 0.75 + (Math.random() - 0.5) * spread;

    const points: Array<{ x: number; y: number }> = [];

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // Apply easing: slow start, fast middle, slow end
      const eased = this.easeInOutCubic(t);

      const x = this.cubicBezier(x0, cp1x, cp2x, x1, eased);
      const y = this.cubicBezier(y0, cp1y, cp2y, y1, eased);
      points.push({ x: Math.round(x), y: Math.round(y) });
    }

    return points;
  }

  private cubicBezier(
    p0: number, p1: number, p2: number, p3: number, t: number
  ): number {
    const mt = 1 - t;
    return (
      mt * mt * mt * p0 +
      3 * mt * mt * t * p1 +
      3 * mt * t * t * p2 +
      t * t * t * p3
    );
  }

  private easeInOutCubic(t: number): number {
    return t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
}
