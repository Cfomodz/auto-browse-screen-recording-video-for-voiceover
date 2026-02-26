import { CameraConfig, ZoomKeyframe } from '../core/types';
import { Logger } from '../utils/logger';

/**
 * Dynamic camera/zoom engine.
 *
 * Converts ZoomKeyframe arrays into FFmpeg filter expressions that
 * apply smooth zoom-and-pan effects to recorded screen clips.
 *
 * Simulates the "eye-tracking" effect of a video editor following
 * the user's gaze — zooming to the search bar while typing, pulling
 * out to see results, zooming to the element about to be clicked, etc.
 *
 * The zoom is achieved by cropping a sub-region of the full-resolution
 * source frame and scaling it back up, with smooth interpolation between
 * keyframes using the configured easing function.
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
   * Generate an FFmpeg zoompan filter string for a clip.
   *
   * The approach: use the `crop` + `scale` filters with expression-based
   * animation. We interpolate between keyframes to smoothly move the
   * crop window across the frame.
   *
   * @param keyframes     Zoom keyframes for this clip
   * @param clipDuration  Duration of the clip in seconds
   * @param sourceWidth   Source video width in pixels
   * @param sourceHeight  Source video height in pixels
   * @param fps           Frame rate
   * @returns FFmpeg complex filter string, or null if no zoom needed
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

    // Always start with a full-frame keyframe if none exists at t=0
    const sorted = [...keyframes].sort((a, b) => a.timeOffset - b.timeOffset);
    if (sorted[0].timeOffset > 0) {
      sorted.unshift({
        timeOffset: 0,
        region: { x: 0.5, y: 0.5, width: 1.0, height: 1.0 },
        label: 'initial-full-frame',
      });
    }

    // Add a return-to-full-frame at end if the last keyframe isn't there
    const lastKf = sorted[sorted.length - 1];
    if (lastKf.timeOffset < clipDuration - 0.5) {
      sorted.push({
        timeOffset: clipDuration,
        region: { x: 0.5, y: 0.5, width: 1.0, height: 1.0 },
        label: 'final-full-frame',
      });
    }

    // Convert keyframes to absolute pixel values and frame numbers
    const pixelKeyframes = sorted.map((kf) => {
      const cropW = Math.round(sourceWidth * Math.max(kf.region.width, 1 / this.config.maxZoom));
      const cropH = Math.round(sourceHeight * Math.max(kf.region.height, 1 / this.config.maxZoom));
      const cropX = Math.round(kf.region.x * sourceWidth - cropW / 2);
      const cropY = Math.round(kf.region.y * sourceHeight - cropH / 2);
      const frame = Math.round(kf.timeOffset * fps);

      return {
        frame,
        cropX: Math.max(0, Math.min(cropX, sourceWidth - cropW)),
        cropY: Math.max(0, Math.min(cropY, sourceHeight - cropH)),
        cropW: Math.min(cropW, sourceWidth),
        cropH: Math.min(cropH, sourceHeight),
        label: kf.label,
      };
    });

    this.logger.info(
      `Building zoom filter: ${pixelKeyframes.length} keyframes over ${clipDuration.toFixed(1)}s`
    );
    for (const kf of pixelKeyframes) {
      this.logger.info(
        `  [frame ${kf.frame}] ${kf.label}: crop=${kf.cropW}x${kf.cropH}+${kf.cropX}+${kf.cropY}`
      );
    }

    // Build the FFmpeg expression that interpolates between keyframes.
    // We use the crop filter with expressions that reference frame number (n).
    const cropXExpr = this.buildInterpolationExpr(pixelKeyframes, 'cropX');
    const cropYExpr = this.buildInterpolationExpr(pixelKeyframes, 'cropY');
    const cropWExpr = this.buildInterpolationExpr(pixelKeyframes, 'cropW');
    const cropHExpr = this.buildInterpolationExpr(pixelKeyframes, 'cropH');

    // The filter chain:
    // 1. Crop the animated region from the source
    // 2. Scale the crop back up to the output resolution
    const filter = [
      `crop='${cropWExpr}:${cropHExpr}:${cropXExpr}:${cropYExpr}'`,
      `scale=${sourceWidth}:${sourceHeight}:flags=lanczos`,
    ].join(',');

    return filter;
  }

  /**
   * Build an FFmpeg expression string that interpolates a property
   * between keyframes using the frame number (n).
   *
   * Produces a chain of if(lt(n,frame), lerp, if(lt(n,frame), lerp, ...))
   * expressions that FFmpeg evaluates per-frame.
   */
  private buildInterpolationExpr(
    keyframes: Array<{ frame: number; cropX: number; cropY: number; cropW: number; cropH: number }>,
    prop: 'cropX' | 'cropY' | 'cropW' | 'cropH'
  ): string {
    if (keyframes.length === 1) {
      return String(keyframes[0][prop]);
    }

    // Build nested if/else for each segment between keyframes
    let expr = String(keyframes[keyframes.length - 1][prop]);

    for (let i = keyframes.length - 2; i >= 0; i--) {
      const from = keyframes[i];
      const to = keyframes[i + 1];
      const fromVal = from[prop];
      const toVal = to[prop];
      const startFrame = from.frame;
      const endFrame = to.frame;
      const frameDiff = Math.max(1, endFrame - startFrame);

      // Linear interpolation with easing applied
      const easingExpr = this.buildEasingExpr(startFrame, frameDiff);

      const lerpExpr =
        `${fromVal}+(${toVal}-${fromVal})*${easingExpr}`;

      expr = `if(lt(n\\,${endFrame})\\,${lerpExpr}\\,${expr})`;
    }

    return expr;
  }

  /**
   * Build an easing expression based on normalized progress t = (n - startFrame) / frameDiff.
   * Returns an FFmpeg expression string that evaluates to [0, 1].
   */
  private buildEasingExpr(startFrame: number, frameDiff: number): string {
    // t = (n - startFrame) / frameDiff, clamped to [0, 1]
    const tExpr = `min(1\\,max(0\\,(n-${startFrame})/${frameDiff}))`;

    switch (this.config.easing) {
      case 'ease-in':
        // t^2
        return `pow(${tExpr}\\,2)`;
      case 'ease-out':
        // 1 - (1-t)^2
        return `(1-pow(1-${tExpr}\\,2))`;
      case 'ease-in-out':
        // Smoothstep: 3t^2 - 2t^3
        return `(3*pow(${tExpr}\\,2)-2*pow(${tExpr}\\,3))`;
      case 'linear':
      default:
        return tExpr;
    }
  }
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
