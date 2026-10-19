import { CameraConfig, ZoomKeyframe } from '../core/types';
import { Logger } from '../utils/logger';

/** A crop window in source pixels. Always has the source's aspect ratio. */
export interface CameraRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One eased camera move between two crop windows. */
export interface CameraMove {
  /** First frame of the move (0-based). */
  startFrame: number;
  /** Length of the move in frames (>= 1). */
  frames: number;
  from: CameraRect;
  to: CameraRect;
  label: string;
}

/**
 * Dynamic camera/zoom engine.
 *
 * Converts ZoomKeyframe arrays into an FFmpeg filter that applies smooth
 * zoom-and-pan effects to recorded screen clips.
 *
 * Simulates the "eye-tracking" effect of a video editor following
 * the user's gaze — zooming to the search bar while typing, pulling
 * out to see results, zooming to the element about to be clicked, etc.
 *
 * Camera model: each keyframe starts a move toward its region at its
 * timeOffset. The move lasts `transitionMs` (shortened if the next keyframe
 * arrives sooner) with the configured easing, then the camera holds still
 * until the next keyframe.
 *
 * The filter is `perspective` with per-frame evaluation: it maps the crop
 * window's corners onto the output corners with sub-pixel accuracy, so zooms
 * and pans are smooth. (`crop` cannot be used here — FFmpeg evaluates its
 * width/height only once, so an animated crop never actually zooms.)
 */
export class ZoomEngine {
  private config: CameraConfig;
  private logger: Logger;

  constructor(config: CameraConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Generate the FFmpeg zoom filter for a clip.
   *
   * @param keyframes     Zoom keyframes for this clip (times in clip seconds)
   * @param clipDuration  Duration of the clip in seconds
   * @param sourceWidth   Source video width in pixels
   * @param sourceHeight  Source video height in pixels
   * @param fps           Frame rate
   * @returns FFmpeg filter string, or null if the camera never leaves full frame
   */
  buildFilterChain(
    keyframes: ZoomKeyframe[],
    clipDuration: number,
    sourceWidth: number,
    sourceHeight: number,
    fps: number
  ): string | null {
    if (!this.config.enabled || keyframes.length === 0) {
      return null;
    }

    const moves = this.planCameraMoves(keyframes, clipDuration, sourceWidth, sourceHeight, fps);
    if (moves.length === 0) {
      return null;
    }

    this.logger.info(
      `Building zoom filter: ${moves.length} camera moves over ${clipDuration.toFixed(1)}s`
    );
    for (const m of moves) {
      this.logger.info(
        `  [frame ${m.startFrame}+${m.frames}] ${m.label}: ` +
          `${Math.round(m.to.w)}x${Math.round(m.to.h)}+${Math.round(m.to.x)}+${Math.round(m.to.y)}`
      );
    }

    const full: CameraRect = { x: 0, y: 0, w: sourceWidth, h: sourceHeight };
    const left = this.buildEdgeExpr(full, moves, (r) => r.x);
    const top = this.buildEdgeExpr(full, moves, (r) => r.y);
    const right = this.buildEdgeExpr(full, moves, (r) => r.x + r.w);
    const bottom = this.buildEdgeExpr(full, moves, (r) => r.y + r.h);

    // sense=source: the four given source points are sent to the output
    // corners (top-left, top-right, bottom-left, bottom-right).
    return (
      `perspective=` +
      `x0='${left}':y0='${top}':x1='${right}':y1='${top}':` +
      `x2='${left}':y2='${bottom}':x3='${right}':y3='${bottom}':` +
      `interpolation=cubic:sense=source:eval=frame`
    );
  }

  /**
   * Resolve a normalized keyframe region into a crop window that keeps the
   * source aspect ratio (no squashing), never zooms past maxZoom, and stays
   * inside the frame.
   */
  regionToRect(
    region: ZoomKeyframe['region'],
    sourceWidth: number,
    sourceHeight: number
  ): CameraRect {
    const zoom = Math.max(
      1,
      Math.min(
        this.config.maxZoom,
        1 / Math.max(region.width, 1e-6),
        1 / Math.max(region.height, 1e-6)
      )
    );
    const w = sourceWidth / zoom;
    const h = sourceHeight / zoom;
    return {
      x: clamp(region.x * sourceWidth - w / 2, 0, sourceWidth - w),
      y: clamp(region.y * sourceHeight - h / 2, 0, sourceHeight - h),
      w,
      h,
    };
  }

  /**
   * Turn keyframes into camera moves. The camera starts at full frame; each
   * keyframe starts a move from wherever the camera is to the keyframe's
   * region. Keyframes landing on the same frame collapse to the last one, and
   * moves are shortened so they never overlap the next one.
   */
  planCameraMoves(
    keyframes: ZoomKeyframe[],
    clipDuration: number,
    sourceWidth: number,
    sourceHeight: number,
    fps: number
  ): CameraMove[] {
    const lastFrame = Math.max(0, Math.round(clipDuration * fps));
    const transitionFrames = Math.max(1, Math.round((this.config.transitionMs / 1000) * fps));

    const timed = [...keyframes]
      .map((kf) => ({ kf, frame: Math.max(0, Math.round(kf.timeOffset * fps)) }))
      .filter(({ frame }) => frame < lastFrame)
      .sort((a, b) => a.frame - b.frame);

    const moves: CameraMove[] = [];
    let current: CameraRect = { x: 0, y: 0, w: sourceWidth, h: sourceHeight };

    for (let i = 0; i < timed.length; i++) {
      const { kf, frame } = timed[i];
      const nextFrame = i + 1 < timed.length ? timed[i + 1].frame : lastFrame;
      if (nextFrame <= frame) continue; // superseded by a keyframe on the same frame

      const target = this.regionToRect(kf.region, sourceWidth, sourceHeight);
      if (rectsEqual(current, target)) continue;

      moves.push({
        startFrame: frame,
        frames: Math.min(transitionFrames, nextFrame - frame),
        from: current,
        to: target,
        label: kf.label,
      });
      current = target;
    }

    return moves;
  }

  /**
   * Build an FFmpeg expression for one edge of the crop window.
   *
   * Moves never overlap, so the edge at any frame is its starting value plus
   * each move's delta scaled by that move's eased progress (0 before the move,
   * 1 after it). A sum keeps the expression short — nested if() chains grow
   * long enough to hit the Windows command-line limit.
   */
  private buildEdgeExpr(
    start: CameraRect,
    moves: CameraMove[],
    edge: (r: CameraRect) => number
  ): string {
    let expr = formatNumber(edge(start));
    for (const m of moves) {
      const delta = edge(m.to) - edge(m.from);
      if (Math.abs(delta) < 0.005) continue;
      expr += `${delta >= 0 ? '+' : ''}${formatNumber(delta)}*${this.buildEasingExpr(m.startFrame, m.frames)}`;
    }
    return expr;
  }

  /**
   * Eased progress of a move in [0, 1] as an FFmpeg expression.
   * The perspective filter's `in` counter is 1-based, so frame n is in = n + 1.
   */
  private buildEasingExpr(startFrame: number, frames: number): string {
    const t = `clip((in-${startFrame + 1})/${frames}\\,0\\,1)`;

    switch (this.config.easing) {
      case 'ease-in':
        // t^2
        return `pow(${t}\\,2)`;
      case 'ease-out':
        // 1 - (1-t)^2 = t(2-t)
        return `st(0\\,${t})*(2-ld(0))`;
      case 'ease-in-out':
        // Smoothstep: 3t^2 - 2t^3 = t*t*(3-2t)
        return `st(0\\,${t})*ld(0)*(3-2*ld(0))`;
      case 'linear':
      default:
        return t;
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function rectsEqual(a: CameraRect, b: CameraRect): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.w - b.w) < 0.5 &&
    Math.abs(a.h - b.h) < 0.5
  );
}

function formatNumber(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * Pre-built zoom keyframe patterns for common module actions.
 *
 * Modules use these to describe the "camera journey" for their action
 * without needing to compute pixel coordinates. The camera system
 * translates these normalized regions into actual crop coordinates.
 */
export const ZoomPresets = {
  /** Zoom into the search bar area (top-center of page). */
  searchBarFocus(timeOffset: number): ZoomKeyframe {
    return {
      timeOffset,
      region: { x: 0.5, y: 0.15, width: 0.6, height: 0.3 },
      label: 'search-bar-focus',
    };
  },

  /** Zoom out to full browser window. */
  fullWindow(timeOffset: number): ZoomKeyframe {
    return {
      timeOffset,
      region: { x: 0.5, y: 0.5, width: 1.0, height: 1.0 },
      label: 'full-window',
    };
  },

  /** Zoom to the search results (left 2/3, below search bar). */
  searchResultsFocus(timeOffset: number): ZoomKeyframe {
    return {
      timeOffset,
      region: { x: 0.4, y: 0.55, width: 0.7, height: 0.7 },
      label: 'search-results-focus',
    };
  },

  /** Zoom to the tab bar (News, Images, etc.) above search results. */
  tabBarFocus(timeOffset: number): ZoomKeyframe {
    return {
      timeOffset,
      region: { x: 0.5, y: 0.22, width: 0.8, height: 0.2 },
      label: 'tab-bar-focus',
    };
  },

  /** Zoom to the right side where image previews / knowledge panels appear. */
  rightPanelFocus(timeOffset: number): ZoomKeyframe {
    return {
      timeOffset,
      region: { x: 0.75, y: 0.5, width: 0.45, height: 0.7 },
      label: 'right-panel-focus',
    };
  },

  /** Zoom to a specific element's bounding box (normalized coordinates). */
  elementFocus(
    timeOffset: number,
    normX: number,
    normY: number,
    label: string
  ): ZoomKeyframe {
    return {
      timeOffset,
      region: { x: normX, y: normY, width: 0.5, height: 0.4 },
      label,
    };
  },

  /**
   * Zoom to an element's bounding box (pixels), keeping some context around
   * it. The zoom itself is capped by maxZoom when the camera resolves it.
   */
  boxFocus(
    timeOffset: number,
    box: { x: number; y: number; width: number; height: number },
    viewport: { width: number; height: number },
    label: string
  ): ZoomKeyframe {
    return {
      timeOffset,
      region: {
        x: Math.min(1, Math.max(0, (box.x + box.width / 2) / viewport.width)),
        y: Math.min(1, Math.max(0, (box.y + box.height / 2) / viewport.height)),
        width: Math.min(1, Math.max(0.05, (box.width * 1.5) / viewport.width)),
        height: Math.min(1, Math.max(0.05, (box.height * 3) / viewport.height)),
      },
      label,
    };
  },

  /** Zoom to the Google definition card area (top-center). */
  definitionCardFocus(timeOffset: number): ZoomKeyframe {
    return {
      timeOffset,
      region: { x: 0.45, y: 0.4, width: 0.6, height: 0.5 },
      label: 'definition-card-focus',
    };
  },

  /** Wide view of an image grid. */
  imageGridFocus(timeOffset: number): ZoomKeyframe {
    return {
      timeOffset,
      region: { x: 0.5, y: 0.55, width: 0.85, height: 0.75 },
      label: 'image-grid-focus',
    };
  },
} as const;
