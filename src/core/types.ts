/**
 * Core type definitions for the auto-broll pipeline.
 */

/** A single timestamped segment from the voiceover transcript. */
export interface TranscriptSegment {
  startTime: number;   // seconds
  endTime: number;     // seconds
  text: string;
}

/** A topic/concept extracted from the transcript by the LLM. */
export interface ExtractedTopic {
  topic: string;
  description: string;
  /** Which transcript segments this topic spans. */
  segments: TranscriptSegment[];
  /** Suggested module actions for this topic. */
  suggestedActions: ModuleActionType[];
}

/** The types of browser actions modules can perform. */
export type ModuleActionType =
  | 'web-search'
  | 'news-search'
  | 'definition-search'
  | 'image-search';

/** Configuration for a single module. */
export interface ModuleConfig {
  enabled: boolean;
  /** Module-specific options. */
  options?: Record<string, unknown>;
}

/** Top-level pipeline configuration. */
export interface PipelineConfig {
  /** Path to the transcript file (SRT, VTT, or plain text with timestamps). */
  transcriptPath: string;
  /** Path to the voiceover audio file. */
  audioPath: string;
  /** Directory for intermediate recordings and final output. */
  outputDir: string;
  /** Browser viewport dimensions. */
  viewport: { width: number; height: number };
  /** Path to Chrome/Chromium executable (required for puppeteer-core). */
  browserExecutablePath?: string;
  /** Which search engine to use. */
  searchEngine: 'google' | 'brave' | 'duckduckgo';
  /** LLM provider config for transcript analysis. API key from .env (DEEPSEEK_API_KEY / OPENAI_API_KEY) if not in config. */
  llm: {
    provider: 'deepseek' | 'openai';
    apiKey?: string;
    model?: string;
  };
  /** Per-module configuration. */
  modules: Record<ModuleActionType, ModuleConfig>;
  /** Mouse animation style. */
  mouseStyle: 'realistic' | 'smooth' | 'instant';
  /** Output video settings. */
  video: {
    fps: number;
    resolution: { width: number; height: number };
    format: 'mp4' | 'webm';
  };
  /** Sound effects configuration. */
  sfx?: SfxConfig;
  /** Dynamic camera/zoom configuration. */
  camera?: CameraConfig;
  /** Typing animation configuration. */
  typing?: TypingConfig;
  /** Cursor rendering / click effects configuration. */
  cursor?: CursorConfig;
}

/** Sound effects configuration. */
export interface SfxConfig {
  enabled: boolean;
  /** Directory containing audio samples. */
  libraryPath: string;
  /** Volume level 0.0–1.0 for SFX relative to voiceover. */
  volume: number;
  mouseClick: {
    enabled: boolean;
    /**
     * Subdirectory within libraryPath for click sounds.
     * May contain flat WAV files (legacy) or left/ right/ double/ subdirs
     * each holding ClickClipMeta JSON sidecars alongside audio files.
     */
    samplesDir: string;
  };
  keyboardTyping: {
    enabled: boolean;
    /** Directory of pre-recorded keystroke audio clips (from keystroke-recorder). */
    samplesDir: string;
    /** Loudness target in LUFS when extracting clips from sessions (default -14; -10 is louder). */
    targetLUFS?: number;
  };
  mouseScroll?: {
    enabled: boolean;
    /** Subdirectory within libraryPath for scroll sounds (ScrollClipMeta JSON sidecars). */
    samplesDir: string;
  };
}

/** Dynamic camera/zoom configuration. */
export interface CameraConfig {
  enabled: boolean;
  /** Zoom intensity: 1.0 = no zoom, 1.3 = 30% zoom, etc. */
  maxZoom: number;
  /** Duration of zoom transitions in milliseconds. */
  transitionMs: number;
  /** Easing curve: smooth ease-in-out or linear. */
  easing: 'ease-in-out' | 'ease-in' | 'ease-out' | 'linear';
}

/**
 * A zoom keyframe instruction produced by a module.
 * Describes where the camera should focus at a given moment.
 */
export interface ZoomKeyframe {
  /** Time offset in seconds from the start of this clip. */
  timeOffset: number;
  /** Target region to zoom into (normalized 0–1 coordinates). */
  region: {
    x: number;       // center X (0 = left edge, 1 = right edge)
    y: number;       // center Y (0 = top, 1 = bottom)
    width: number;   // fraction of viewport width to show (1 = full, 0.5 = 2x zoom)
    height: number;  // fraction of viewport height to show
  };
  /** Human-readable label for debugging. */
  label: string;
}

/**
 * A single keystroke event with timing, used as metadata for
 * pre-recorded typing audio clips.
 */
export interface KeystrokeEvent {
  /** Character or key name ('a', 'space', 'backspace', 'enter', etc.) */
  key: string;
  /** Milliseconds since the start of this audio clip. */
  timestampMs: number;
}

/**
 * Metadata for a pre-recorded typing audio clip.
 * Stored alongside the audio file as a .json sidecar.
 */
export interface TypingClipMeta {
  /** Path to the audio file. */
  audioFile: string;
  /** Duration of the clip in milliseconds. */
  durationMs: number;
  /** The text that was typed during recording. */
  typedText: string;
  /** Word count in the typed text. */
  wordCount: number;
  /** Number of backspace sequences in the clip. */
  backspaceSequences: number;
  /** Max consecutive backspaces in any single sequence. */
  maxConsecutiveBackspaces: number;
  /** Ordered keystroke events with exact timing. */
  keystrokes: KeystrokeEvent[];
}

// ─── Cursor Effects ─────────────────────────────────────────────────────────

/** Cursor rendering configuration. */
export interface CursorConfig {
  enabled: boolean;
  /** Path to a custom cursor image (PNG with transparency). Uses default SVG dot if omitted. */
  imagePath?: string;
  /** Cursor size in pixels (diameter for the default dot, or scale target for custom image). */
  size: number;
  /** Cursor color as CSS color string (only for default cursor). */
  color: string;

  /** Click scaling (haptic visual feedback). */
  clickEffect: {
    enabled: boolean;
    /** Scale factor on mousedown (e.g. 0.85 = shrink 15%). */
    downScale: number;
    /** Duration of the down animation in ms. */
    downDurationMs: number;
    /** Spring overshoot on release (e.g. 1.08 = 8% overshoot). */
    releaseOvershoot: number;
    /** Duration of the release spring animation in ms. */
    releaseDurationMs: number;
  };

  /** Ripple / ring effect on click. */
  rippleEffect: {
    enabled: boolean;
    /** Number of concentric rings to emit per click. */
    ringCount: number;
    /** Maximum radius the ring expands to (in pixels). */
    maxRadius: number;
    /** Duration of each ring's expand + fade animation in ms. */
    durationMs: number;
    /** Delay between successive rings in ms. */
    staggerMs: number;
    /** Ring color as CSS color string. */
    color: string;
    /** Ring stroke width in pixels. */
    strokeWidth: number;
  };

  /** Resting jitter — subtle Perlin-noise micro-movement when idle. */
  restingJitter: {
    enabled: boolean;
    /** Max displacement in pixels from the resting position. */
    amplitude: number;
    /** Speed of the noise oscillation (lower = smoother). */
    frequency: number;
  };
}

/**
 * A cursor visual event recorded during browser interaction.
 * Used to overlay cursor effects in post-processing or during live rendering.
 */
export interface CursorEvent {
  /** Time offset in seconds from the start of the clip. */
  timeOffset: number;
  /** Event type. */
  type: 'move' | 'click' | 'rest-start' | 'rest-end';
  /** Cursor position at event time. */
  x: number;
  y: number;
  /** For click events, which button was pressed. */
  clickType?: ClickButtonType;
}

/** Typing animator configuration. */
export interface TypingConfig {
  /** Base delay between keystrokes in ms. */
  baseDelayMs: number;
  /** Random variance applied to each keystroke delay (0–1 scale, like Kdenlive inconsistency). */
  inconsistency: number;
  /** Probability of making a typo and correcting it (0–1). */
  mistakeProbability: number;
  /** When a mistake happens, max chars typed before correction. */
  maxMistakeLength: number;
  /** Pause range (ms) between words simulating thinking. */
  thinkPause: { minMs: number; maxMs: number };
}

/** A recorded screen segment tied to a topic. */
export interface RecordedSegment {
  topic: ExtractedTopic;
  action: ModuleActionType;
  filePath: string;       // path to the recorded video clip
  durationSeconds: number;
  /** The transcript time window this clip should cover. */
  startTime: number;
  endTime: number;
  /** Zoom keyframes for dynamic camera during this segment. */
  zoomKeyframes?: ZoomKeyframe[];
  /** SFX events to overlay during this segment. */
  sfxEvents?: SfxEvent[];
  /** Cursor movement and click events for this segment. */
  cursorEvents?: CursorEvent[];
  /** True if SFX has been baked into the clip file (for debugging and progressive assembly). */
  sfxBaked?: boolean;
}

/** A sound effect event to overlay at a specific time in a clip. */
export interface SfxEvent {
  /** Time offset in seconds from the start of the clip. */
  timeOffset: number;
  /** Type of sound effect. */
  type: 'click' | 'typing' | 'scroll';
  /** Path to the audio sample file. */
  audioFile: string;
  /** Duration of this SFX clip in seconds. */
  durationSeconds: number;
}

// ─── Click SFX ──────────────────────────────────────────────────────────────

/** Mouse button type for click SFX classification. */
export type ClickButtonType = 'left' | 'right' | 'double';

/**
 * Metadata for a pre-recorded click audio clip.
 * Stored alongside the audio file as a .json sidecar.
 *
 * clickSignalMs is the key alignment field: it tells the playback engine
 * how far into the audio the actual click transient lands so the SfxEvent
 * timeOffset can be shifted backward by that amount, placing the click
 * sound precisely on the moment the browser fires the click action.
 */
export interface ClickClipMeta {
  audioFile: string;
  durationMs: number;
  clickType: ClickButtonType;
  /** Ms from the start of the audio file to the click transient. */
  clickSignalMs: number;
}

// ─── Scroll SFX ─────────────────────────────────────────────────────────────

/**
 * A single wheel event captured during a scroll recording session.
 * timestampMs is relative to the start of the audio clip.
 */
export interface ScrollEvent {
  /** Scroll delta in pixels (positive = down, negative = up). */
  deltaY: number;
  /** Ms from start of audio clip when this wheel event was received. */
  timestampMs: number;
}

/**
 * Metadata for a pre-recorded scroll audio clip.
 * Stored alongside the audio file as a .json sidecar.
 *
 * The events array drives browser scroll automation: the playback engine
 * replays each wheel event at its timestampMs offset, making the visual
 * scroll velocity and rhythm match the recorded trackpad gesture.
 */
export interface ScrollClipMeta {
  audioFile: string;
  durationMs: number;
  /** Sum of all deltaY values (absolute pixels, always positive). */
  totalDeltaY: number;
  direction: 'down' | 'up';
  /** Ordered wheel events with exact timing. */
  events: ScrollEvent[];
}

/** Result of the full pipeline run. */
export interface PipelineResult {
  outputPath: string;
  segments: RecordedSegment[];
  durationSeconds: number;
}

/** Events emitted during pipeline execution. */
export type PipelineEvent =
  | { type: 'analysis-start' }
  | { type: 'analysis-complete'; topics: ExtractedTopic[] }
  | { type: 'recording-start'; topic: ExtractedTopic; action: ModuleActionType }
  | { type: 'recording-complete'; segment: RecordedSegment }
  | { type: 'recording-skip'; segment: RecordedSegment }
  | { type: 'assembly-start' }
  | { type: 'assembly-complete'; outputPath: string }
  | { type: 'error'; message: string; error?: Error };
