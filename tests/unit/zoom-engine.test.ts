import { describe, it, expect } from 'vitest';
import { ZoomEngine, ZoomPresets } from '../../src/camera/zoom-engine';
import { CameraConfig, ZoomKeyframe } from '../../src/core/types';
import { createLogger } from '../../src/utils/logger';

const logger = createLogger('test');
logger.silent = true;

function makeConfig(overrides?: Partial<CameraConfig>): CameraConfig {
  return {
    enabled: true,
    maxZoom: 1.4,
    transitionMs: 800,
    easing: 'ease-in-out',
    ...overrides,
  };
}

describe('ZoomEngine', () => {
  describe('buildFilterChain', () => {
    it('returns null when disabled', () => {
      const engine = new ZoomEngine(makeConfig({ enabled: false }), logger);
      const kf: ZoomKeyframe[] = [ZoomPresets.searchBarFocus(0)];
      const filter = engine.buildFilterChain(kf, 5, 1920, 1080, 30);
      expect(filter).toBeNull();
    });

    it('returns null for empty keyframes', () => {
      const engine = new ZoomEngine(makeConfig(), logger);
      const filter = engine.buildFilterChain([], 5, 1920, 1080, 30);
      expect(filter).toBeNull();
    });

    it('returns null when the camera never leaves full frame', () => {
      const engine = new ZoomEngine(makeConfig(), logger);
      const kf = [ZoomPresets.fullWindow(0), ZoomPresets.fullWindow(2)];
      expect(engine.buildFilterChain(kf, 5, 1920, 1080, 30)).toBeNull();
    });

    it('generates a per-frame perspective filter', () => {
      const engine = new ZoomEngine(makeConfig(), logger);
      const kf: ZoomKeyframe[] = [ZoomPresets.searchBarFocus(1)];
      const filter = engine.buildFilterChain(kf, 5, 1920, 1080, 30);
      expect(filter).not.toBeNull();
      expect(filter).toMatch(/^perspective=/);
      expect(filter).toContain('sense=source');
      expect(filter).toContain('eval=frame');
      // Expressions reference the input frame counter
      expect(filter).toContain('clip((in-');
    });

    it('starts each move at its keyframe frame (perspective in is 1-based)', () => {
      const engine = new ZoomEngine(makeConfig({ easing: 'linear' }), logger);
      const filter = engine.buildFilterChain([ZoomPresets.searchBarFocus(2)], 5, 1920, 1080, 30);
      // 2s * 30fps = frame 60 → in = 61; transition 800ms = 24 frames
      expect(filter).toContain('clip((in-61)/24');
    });

    it('uses smoothstep easing for ease-in-out', () => {
      const engine = new ZoomEngine(makeConfig({ easing: 'ease-in-out' }), logger);
      const kf: ZoomKeyframe[] = [ZoomPresets.searchBarFocus(0), ZoomPresets.fullWindow(3)];
      const filter = engine.buildFilterChain(kf, 5, 1920, 1080, 30);
      // Smoothstep: t*t*(3-2t)
      expect(filter).toContain('ld(0)*(3-2*ld(0))');
    });

    it('uses linear easing when configured', () => {
      const engine = new ZoomEngine(makeConfig({ easing: 'linear' }), logger);
      const kf: ZoomKeyframe[] = [ZoomPresets.searchBarFocus(0), ZoomPresets.fullWindow(3)];
      const filter = engine.buildFilterChain(kf, 5, 1920, 1080, 30);
      expect(filter).not.toContain('pow(');
      expect(filter).not.toContain('ld(0)');
    });

    it('uses ease-in (t^2) when configured', () => {
      const engine = new ZoomEngine(makeConfig({ easing: 'ease-in' }), logger);
      const kf: ZoomKeyframe[] = [ZoomPresets.searchBarFocus(0), ZoomPresets.fullWindow(3)];
      const filter = engine.buildFilterChain(kf, 5, 1920, 1080, 30);
      expect(filter).toContain('pow(');
    });

    it('stays short enough for the Windows command line with many keyframes', () => {
      const engine = new ZoomEngine(makeConfig(), logger);
      const kf: ZoomKeyframe[] = [];
      for (let i = 0; i < 30; i++) {
        kf.push(i % 2 === 0 ? ZoomPresets.searchResultsFocus(i) : ZoomPresets.fullWindow(i));
      }
      const filter = engine.buildFilterChain(kf, 31, 1920, 1080, 30);
      expect(filter!.length).toBeLessThan(16000);
    });
  });

  describe('regionToRect', () => {
    it('respects maxZoom by clamping the crop window', () => {
      const engine = new ZoomEngine(makeConfig({ maxZoom: 2.0 }), logger);
      const rect = engine.regionToRect({ x: 0.5, y: 0.5, width: 0.3, height: 0.3 }, 1920, 1080);
      // 0.3 would be 3.3x — clamped to 2x → 960x540
      expect(rect.w).toBeCloseTo(960);
      expect(rect.h).toBeCloseTo(540);
    });

    it('never zooms out past full frame', () => {
      const engine = new ZoomEngine(makeConfig(), logger);
      const rect = engine.regionToRect({ x: 0.5, y: 0.5, width: 1, height: 1 }, 1920, 1080);
      expect(rect).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    });

    it('preserves the source aspect ratio for non-16:9 regions', () => {
      const engine = new ZoomEngine(makeConfig(), logger);
      const kf = ZoomPresets.tabBarFocus(0); // 0.8 x 0.2 region
      const rect = engine.regionToRect(kf.region, 1920, 1080);
      expect(rect.w / rect.h).toBeCloseTo(1920 / 1080, 5);
      // Zoom is limited by the wide dimension so the whole bar stays visible
      expect(rect.w).toBeCloseTo(1920 * 0.8);
    });

    it('keeps the crop window inside the frame near the edges', () => {
      const engine = new ZoomEngine(makeConfig(), logger);
      const rect = engine.regionToRect({ x: 0.98, y: 0.02, width: 0.3, height: 0.3 }, 1920, 1080);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeCloseTo(1920);
      expect(rect.y).toBeCloseTo(0);
    });
  });

  describe('planCameraMoves', () => {
    it('starts from full frame and moves to each keyframe region', () => {
      const engine = new ZoomEngine(makeConfig(), logger);
      const moves = engine.planCameraMoves(
        [ZoomPresets.searchBarFocus(0), ZoomPresets.fullWindow(3)],
        5, 1920, 1080, 30
      );
      expect(moves).toHaveLength(2);
      expect(moves[0].from).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
      expect(moves[0].startFrame).toBe(0);
      expect(moves[0].frames).toBe(24); // 800ms at 30fps
      expect(moves[1].from).toEqual(moves[0].to);
      expect(moves[1].to).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
      expect(moves[1].startFrame).toBe(90);
    });

    it('shortens a move when the next keyframe arrives first', () => {
      const engine = new ZoomEngine(makeConfig({ transitionMs: 1000 }), logger);
      const moves = engine.planCameraMoves(
        [ZoomPresets.searchBarFocus(1), ZoomPresets.fullWindow(1.5)],
        5, 1920, 1080, 30
      );
      expect(moves[0].frames).toBe(15); // cut to the 0.5s gap
      expect(moves[1].frames).toBe(30);
    });

    it('collapses keyframes on the same frame to the last one', () => {
      const engine = new ZoomEngine(makeConfig(), logger);
      const moves = engine.planCameraMoves(
        [ZoomPresets.searchBarFocus(1), ZoomPresets.searchResultsFocus(1)],
        5, 1920, 1080, 30
      );
      expect(moves).toHaveLength(1);
      expect(moves[0].label).toBe('search-results-focus');
    });

    it('skips moves to where the camera already is', () => {
      const engine = new ZoomEngine(makeConfig(), logger);
      const moves = engine.planCameraMoves(
        [ZoomPresets.fullWindow(0), ZoomPresets.searchBarFocus(1), ZoomPresets.searchBarFocus(2)],
        5, 1920, 1080, 30
      );
      expect(moves.map((m) => m.label)).toEqual(['search-bar-focus']);
    });

    it('ignores keyframes after the end of the clip', () => {
      const engine = new ZoomEngine(makeConfig(), logger);
      const moves = engine.planCameraMoves(
        [ZoomPresets.searchBarFocus(1), ZoomPresets.fullWindow(6)],
        5, 1920, 1080, 30
      );
      expect(moves).toHaveLength(1);
    });
  });

  describe('ZoomPresets', () => {
    it('searchBarFocus has correct region', () => {
      const kf = ZoomPresets.searchBarFocus(1.5);
      expect(kf.timeOffset).toBe(1.5);
      expect(kf.region.x).toBe(0.5);
      expect(kf.region.y).toBe(0.15);
      expect(kf.region.width).toBe(0.6);
      expect(kf.label).toBe('search-bar-focus');
    });

    it('fullWindow represents no zoom', () => {
      const kf = ZoomPresets.fullWindow(0);
      expect(kf.region.width).toBe(1.0);
      expect(kf.region.height).toBe(1.0);
      expect(kf.region.x).toBe(0.5);
      expect(kf.region.y).toBe(0.5);
    });

    it('elementFocus accepts custom coordinates and label', () => {
      const kf = ZoomPresets.elementFocus(3.0, 0.7, 0.3, 'my-element');
      expect(kf.timeOffset).toBe(3.0);
      expect(kf.region.x).toBe(0.7);
      expect(kf.region.y).toBe(0.3);
      expect(kf.label).toBe('my-element');
    });

    it('all presets return valid ZoomKeyframe shapes', () => {
      const presets = [
        ZoomPresets.searchBarFocus(0),
        ZoomPresets.fullWindow(1),
        ZoomPresets.searchResultsFocus(2),
        ZoomPresets.tabBarFocus(3),
        ZoomPresets.rightPanelFocus(4),
        ZoomPresets.definitionCardFocus(5),
        ZoomPresets.imageGridFocus(6),
        ZoomPresets.elementFocus(7, 0.5, 0.5, 'test'),
      ];
      for (const kf of presets) {
        expect(kf.timeOffset).toBeGreaterThanOrEqual(0);
        expect(kf.region.x).toBeGreaterThanOrEqual(0);
        expect(kf.region.x).toBeLessThanOrEqual(1);
        expect(kf.region.y).toBeGreaterThanOrEqual(0);
        expect(kf.region.y).toBeLessThanOrEqual(1);
        expect(kf.region.width).toBeGreaterThan(0);
        expect(kf.region.width).toBeLessThanOrEqual(1);
        expect(kf.region.height).toBeGreaterThan(0);
        expect(kf.region.height).toBeLessThanOrEqual(1);
        expect(kf.label.length).toBeGreaterThan(0);
      }
    });
  });
});
