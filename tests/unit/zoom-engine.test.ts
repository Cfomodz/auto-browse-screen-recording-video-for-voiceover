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

    it('generates a crop+scale filter for a single keyframe', () => {
      const engine = new ZoomEngine(makeConfig(), logger);
      const kf: ZoomKeyframe[] = [ZoomPresets.searchBarFocus(1)];
      const filter = engine.buildFilterChain(kf, 5, 1920, 1080, 30);
      expect(filter).not.toBeNull();
      expect(filter).toContain('crop=');
      expect(filter).toContain('scale=1920:1080');
      expect(filter).toContain('lanczos');
    });

    it('generates interpolation expressions with frame references', () => {
      const engine = new ZoomEngine(makeConfig(), logger);
      const kf: ZoomKeyframe[] = [
        ZoomPresets.searchBarFocus(0),
        ZoomPresets.fullWindow(2),
        ZoomPresets.searchResultsFocus(4),
      ];
      const filter = engine.buildFilterChain(kf, 5, 1920, 1080, 30);
      expect(filter).not.toBeNull();
      // Should have if() expressions for per-frame interpolation
      expect(filter).toContain('if(lt(n');
    });

    it('uses smoothstep easing for ease-in-out', () => {
      const engine = new ZoomEngine(makeConfig({ easing: 'ease-in-out' }), logger);
      const kf: ZoomKeyframe[] = [
        ZoomPresets.searchBarFocus(0),
        ZoomPresets.fullWindow(3),
      ];
      const filter = engine.buildFilterChain(kf, 5, 1920, 1080, 30);
      expect(filter).not.toBeNull();
      // Smoothstep: 3t^2 - 2t^3
      expect(filter).toContain('3*pow(');
      expect(filter).toContain('2*pow(');
    });

    it('uses linear easing when configured', () => {
      const engine = new ZoomEngine(makeConfig({ easing: 'linear' }), logger);
      const kf: ZoomKeyframe[] = [
        ZoomPresets.searchBarFocus(0),
        ZoomPresets.fullWindow(3),
      ];
      const filter = engine.buildFilterChain(kf, 5, 1920, 1080, 30);
      expect(filter).not.toBeNull();
      // Linear shouldn't have pow()
      expect(filter).not.toContain('pow(');
    });

    it('uses ease-in (t^2) when configured', () => {
      const engine = new ZoomEngine(makeConfig({ easing: 'ease-in' }), logger);
      const kf: ZoomKeyframe[] = [
        ZoomPresets.searchBarFocus(0),
        ZoomPresets.fullWindow(3),
      ];
      const filter = engine.buildFilterChain(kf, 5, 1920, 1080, 30);
      expect(filter).not.toBeNull();
      expect(filter).toContain('pow(');
    });

    it('inserts initial full-frame keyframe when first kf is not at t=0', () => {
      const engine = new ZoomEngine(makeConfig(), logger);
      const kf: ZoomKeyframe[] = [
        ZoomPresets.searchBarFocus(2), // starts at 2s, not 0
      ];
      const filter = engine.buildFilterChain(kf, 5, 1920, 1080, 30);
      expect(filter).not.toBeNull();
      // Should have interpolation from frame 0 to frame 60 (2s * 30fps)
      expect(filter).toContain('if(');
    });

    it('appends final full-frame keyframe when last kf is far from end', () => {
      const engine = new ZoomEngine(makeConfig(), logger);
      const kf: ZoomKeyframe[] = [
        ZoomPresets.searchBarFocus(0),
        ZoomPresets.searchResultsFocus(2),
        // clip is 10s, last kf at 2s — should get a return-to-full at 10s
      ];
      const filter = engine.buildFilterChain(kf, 10, 1920, 1080, 30);
      expect(filter).not.toBeNull();
      // Frame for 10s at 30fps = 300
      expect(filter).toContain('300');
    });

    it('respects maxZoom by clamping crop dimensions', () => {
      const engine = new ZoomEngine(makeConfig({ maxZoom: 2.0 }), logger);
      const tightZoom: ZoomKeyframe = {
        timeOffset: 0,
        region: { x: 0.5, y: 0.5, width: 0.3, height: 0.3 },
        label: 'tight-zoom',
      };
      const filter = engine.buildFilterChain([tightZoom], 3, 1920, 1080, 30);
      expect(filter).not.toBeNull();
      // With maxZoom=2, minimum crop = 1/2 = 50% of source
      // 0.3 < 0.5, so it should be clamped to 0.5
      // Crop width should be at least 960 (1920 * 0.5)
      expect(filter).toContain('960');
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
