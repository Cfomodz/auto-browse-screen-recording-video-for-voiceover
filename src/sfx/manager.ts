import * as fs from 'fs';
import * as path from 'path';
import {
  SfxConfig,
  SfxEvent,
  KeystrokeEvent,
  TypingClipMeta,
  ClickButtonType,
  ClickClipMeta,
  ScrollClipMeta,
} from '../core/types';
import { Logger } from '../utils/logger';

/**
 * Sound effects manager.
 *
 * Manages a library of audio samples for mouse clicks and keyboard typing.
 * Typing samples are matched to actual typed text using keystroke metadata
 * produced by the keystroke-recorder tool.
 *
 * Provides methods to select appropriate audio clips for different events
 * and returns SfxEvent objects that the video assembler will overlay.
 */
export class SfxManager {
  private config: SfxConfig;
  private logger: Logger;

  /** Legacy flat click WAVs (backwards-compat when subdirs don't exist). */
  private clickSamples: string[] = [];
  /** Click clips categorised by button type (loaded from left/ right/ double/ subdirs). */
  private leftClickClips: ClickClipMeta[] = [];
  private rightClickClips: ClickClipMeta[] = [];
  private doubleClickClips: ClickClipMeta[] = [];
  private lastClickIndex: Record<ClickButtonType, number> = { left: 0, right: 0, double: 0 };

  private typingClips: TypingClipMeta[] = [];
  private scrollClips: ScrollClipMeta[] = [];

  constructor(config: SfxConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    if (config.enabled) {
      this.loadLibrary();
    }
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Load all audio samples from the configured library directories. */
  private loadLibrary(): void {
    // Load click samples (typed subdirs take priority over flat legacy dir)
    if (this.config.mouseClick.enabled) {
      const clickRoot = path.join(this.config.libraryPath, this.config.mouseClick.samplesDir);
      const leftDir = path.join(clickRoot, 'left');
      const rightDir = path.join(clickRoot, 'right');
      const doubleDir = path.join(clickRoot, 'double');

      if (fs.existsSync(leftDir) || fs.existsSync(rightDir) || fs.existsSync(doubleDir)) {
        this.leftClickClips = this.loadClickClips(leftDir, 'left');
        this.rightClickClips = this.loadClickClips(rightDir, 'right');
        this.doubleClickClips = this.loadClickClips(doubleDir, 'double');
        this.logger.info(
          `Loaded click clips: ${this.leftClickClips.length} left, ` +
          `${this.rightClickClips.length} right, ${this.doubleClickClips.length} double`
        );
      } else {
        // Legacy: flat WAV files with no JSON sidecars
        this.clickSamples = this.loadAudioFiles(clickRoot);
        this.logger.info(`Loaded ${this.clickSamples.length} click samples (legacy flat) from ${clickRoot}`);
      }
    }

    // Load typing clips with their metadata
    if (this.config.keyboardTyping.enabled) {
      const typingDir = path.join(this.config.libraryPath, this.config.keyboardTyping.samplesDir);
      this.typingClips = this.loadTypingClips(typingDir);
      this.logger.info(`Loaded ${this.typingClips.length} typing clips from ${typingDir}`);
    }

    // Load scroll clips
    if (this.config.mouseScroll?.enabled) {
      const scrollDir = path.join(this.config.libraryPath, this.config.mouseScroll.samplesDir);
      this.scrollClips = this.loadScrollClips(scrollDir);
      this.logger.info(`Loaded ${this.scrollClips.length} scroll clips from ${scrollDir}`);
    }
  }

  /** Scan a directory for audio files (.wav, .mp3, .ogg, .flac). */
  private loadAudioFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) {
      this.logger.warn(`SFX directory does not exist: ${dir}`);
      return [];
    }

    const extensions = new Set(['.wav', '.mp3', '.ogg', '.flac']);
    return fs.readdirSync(dir)
      .filter((f) => extensions.has(path.extname(f).toLowerCase()))
      .map((f) => path.join(dir, f))
      .sort();
  }

  /**
   * Load typing clips by reading .json sidecar files alongside audio files.
   * Expected structure:
   *   typing/
   *     clip_001.wav
   *     clip_001.json    <-- TypingClipMeta
   *     clip_002.wav
   *     clip_002.json
   */
  private loadTypingClips(dir: string): TypingClipMeta[] {
    if (!fs.existsSync(dir)) {
      this.logger.warn(`Typing clips directory does not exist: ${dir}`);
      return [];
    }

    const clips: TypingClipMeta[] = [];
    const jsonFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));

    for (const jsonFile of jsonFiles) {
      try {
        const meta: TypingClipMeta = JSON.parse(
          fs.readFileSync(path.join(dir, jsonFile), 'utf-8')
        );
        // Resolve audio file path relative to the typing directory
        meta.audioFile = path.resolve(dir, meta.audioFile);
        if (fs.existsSync(meta.audioFile)) {
          clips.push(meta);
        }
      } catch (err) {
        this.logger.warn(`Failed to load typing clip metadata: ${jsonFile}`);
      }
    }

    return clips;
  }

  /**
   * Load click clips from a typed subdir (left/ right/ double/).
   * Expects JSON sidecars with ClickClipMeta. Falls back to creating
   * minimal meta for plain WAV files found without a sidecar.
   */
  private loadClickClips(dir: string, clickType: ClickButtonType): ClickClipMeta[] {
    if (!fs.existsSync(dir)) return [];

    const extensions = new Set(['.wav', '.mp3', '.ogg', '.flac']);
    const clips: ClickClipMeta[] = [];

    const jsonFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const jsonFile of jsonFiles) {
      try {
        const meta: ClickClipMeta = JSON.parse(
          fs.readFileSync(path.join(dir, jsonFile), 'utf-8')
        );
        meta.audioFile = path.resolve(dir, meta.audioFile);
        if (fs.existsSync(meta.audioFile)) clips.push(meta);
      } catch {
        this.logger.warn(`Failed to load click clip metadata: ${jsonFile}`);
      }
    }

    // Also accept bare audio files with no sidecar (0ms clickSignal = audio starts at click)
    if (clips.length === 0) {
      const audioFiles = fs.readdirSync(dir)
        .filter((f) => extensions.has(path.extname(f).toLowerCase()))
        .map((f) => path.join(dir, f));
      for (const audioFile of audioFiles) {
        clips.push({ audioFile, durationMs: 300, clickType, clickSignalMs: 0 });
      }
    }

    return clips;
  }

  /**
   * Load scroll clips from JSON sidecars.
   * Expected structure: scrolls/clip_001.wav + clip_001.json (ScrollClipMeta)
   */
  private loadScrollClips(dir: string): ScrollClipMeta[] {
    if (!fs.existsSync(dir)) {
      this.logger.warn(`Scroll clips directory does not exist: ${dir}`);
      return [];
    }

    const clips: ScrollClipMeta[] = [];
    const jsonFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));

    for (const jsonFile of jsonFiles) {
      try {
        const meta: ScrollClipMeta = JSON.parse(
          fs.readFileSync(path.join(dir, jsonFile), 'utf-8')
        );
        meta.audioFile = path.resolve(dir, meta.audioFile);
        if (fs.existsSync(meta.audioFile)) clips.push(meta);
      } catch {
        this.logger.warn(`Failed to load scroll clip metadata: ${jsonFile}`);
      }
    }

    return clips;
  }

  /**
   * Get a click sound effect event at the given clip-relative time.
   *
   * When typed clip libraries are present (left/ right/ double/ subdirs),
   * the appropriate pool is used and the event timeOffset is adjusted so
   * the click transient aligns with the moment of the browser click.
   *
   * Falls back to the legacy flat-WAV pool if no typed clips exist.
   *
   * @param timeOffset  Clip-relative time (seconds) when the click happens
   * @param clickType   Button pressed (default 'left')
   */
  getClickSfx(timeOffset: number, clickType: ClickButtonType = 'left'): SfxEvent | null {
    if (!this.config.mouseClick.enabled) return null;

    // Typed-clip path
    const pool = clickType === 'right' ? this.rightClickClips
      : clickType === 'double' ? this.doubleClickClips
      : this.leftClickClips;

    if (pool.length > 0) {
      const prev = this.lastClickIndex[clickType];
      const next = (prev + 1 + Math.floor(Math.random() * Math.max(1, pool.length - 1))) % pool.length;
      this.lastClickIndex[clickType] = next;
      const clip = pool[next];

      // Shift start time so the click transient lands on timeOffset
      const adjustedOffset = Math.max(0, timeOffset - clip.clickSignalMs / 1000);
      return {
        timeOffset: adjustedOffset,
        type: 'click',
        audioFile: clip.audioFile,
        durationSeconds: clip.durationMs / 1000,
      };
    }

    // Legacy flat-WAV fallback
    if (this.clickSamples.length === 0) return null;
    const prev = this.lastClickIndex['left'];
    const index = (prev + 1 + Math.floor(Math.random() * Math.max(1, this.clickSamples.length - 1))) % this.clickSamples.length;
    this.lastClickIndex['left'] = index;
    return {
      timeOffset,
      type: 'click',
      audioFile: this.clickSamples[index],
      durationSeconds: 0.3,
    };
  }

  /**
   * Get a scroll sound effect event matching the requested distance and direction.
   *
   * Selects the clip whose totalDeltaY is closest to targetDeltaY; if no
   * clips exist or scroll SFX is disabled, returns null.
   *
   * The returned clip is used by the caller both for audio placement AND to
   * drive the browser's wheel events (via ScrollClipMeta.events).
   *
   * @param targetDeltaY  Absolute pixels to scroll (always positive)
   * @param direction     'down' or 'up'
   * @param timeOffset    Clip-relative time when the scroll starts
   */
  getScrollSfx(
    targetDeltaY: number,
    direction: 'down' | 'up',
    timeOffset: number
  ): { event: SfxEvent; clip: ScrollClipMeta } | null {
    if (!this.config.mouseScroll?.enabled || this.scrollClips.length === 0) return null;

    // Prefer matching direction; fall back to any direction if needed
    const directionMatch = this.scrollClips.filter((c) => c.direction === direction);
    const pool = directionMatch.length > 0 ? directionMatch : this.scrollClips;

    // Closest totalDeltaY to the requested distance
    const best = pool.reduce((prev, curr) =>
      Math.abs(curr.totalDeltaY - targetDeltaY) < Math.abs(prev.totalDeltaY - targetDeltaY)
        ? curr : prev
    );

    return {
      event: {
        timeOffset,
        type: 'scroll',
        audioFile: best.audioFile,
        durationSeconds: best.durationMs / 1000,
      },
      clip: best,
    };
  }

  /**
   * Find the best matching typing audio clip for a given text.
   *
   * Matching strategy (in priority order):
   * 1. Exact word count match with similar character count
   * 2. Closest word count with appropriate backspace sequences
   * 3. Any clip that covers at least the character count needed
   *
   * @param text        The text that will be "typed" in the browser
   * @param timeOffset  When this typing starts in the clip
   * @returns SfxEvent and the keystroke timing data, or null
   */
  getTypingSfx(
    text: string,
    timeOffset: number
  ): { event: SfxEvent; keystrokes: TypingClipMeta } | null {
    if (!this.config.keyboardTyping.enabled || this.typingClips.length === 0) {
      return null;
    }

    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const charCount = text.length;
    const keystrokeCount = (c: TypingClipMeta) => (c.keystrokes ?? []).length;

    // Score each clip: character/keystroke alignment matters most for audio-visual sync
    const scored = this.typingClips
      .filter((clip) => keystrokeCount(clip) >= charCount * 0.5) // Need enough timestamps
      .map((clip) => {
        let score = 0;
        const ksLen = keystrokeCount(clip);

        // Character count similarity (primary - typing rhythm and audio length must match)
        const charDiff = Math.abs(clip.typedText.length - charCount);
        score -= charDiff * 5;

        // Prefer clips with enough keystrokes for our text
        const keystrokeShortfall = Math.max(0, charCount - ksLen);
        score -= keystrokeShortfall * 3;

        // Word count similarity (secondary)
        const wordDiff = Math.abs(clip.wordCount - wordCount);
        score -= wordDiff * 2;

        // Prefer clips without excessive backspaces for clean text
        score -= clip.backspaceSequences * 2;

        return { clip, score };
      });

    if (scored.length === 0) {
      this.logger.debug(
        `No typing clip has enough keystrokes for ${charCount} chars; using best available`
      );
    }
    const fallback = this.typingClips.map((clip) => {
      let score = 0;
      const charDiff = Math.abs(clip.typedText.length - charCount);
      score -= charDiff * 5;
      score -= Math.abs(clip.wordCount - wordCount) * 2;
      score -= clip.backspaceSequences * 2;
      return { clip, score };
    });
    fallback.sort((a, b) => b.score - a.score);
    const candidates = scored.length > 0 ? scored : fallback;
    const sorted = [...candidates].sort((a, b) => b.score - a.score);
    const best = sorted[0];

    if (!best) return null;

    const ks = best.clip.keystrokes ?? [];
    const timestamps = ks.map((k) => k.timestampMs);
    const span = timestamps.length > 0 ? `${timestamps[0]}→${timestamps[timestamps.length - 1]}ms` : 'none';
    this.logger.debug(
      `Typing SFX: ${path.basename(best.clip.audioFile)} | ` +
        `recorded "${best.clip.typedText.substring(0, 25)}${best.clip.typedText.length > 25 ? '...' : ''}" (${best.clip.wordCount}w) | ` +
        `typing "${text.substring(0, 25)}${text.length > 25 ? '...' : ''}" (${text.length} chars) | ` +
        `place @ ${timeOffset.toFixed(2)}s | ` +
        `${ks.length} keystrokes, timestamps ${span}`
    );

    return {
      event: {
        timeOffset,
        type: 'typing',
        audioFile: best.clip.audioFile,
        durationSeconds: best.clip.durationMs / 1000,
      },
      keystrokes: best.clip,
    };
  }

  /**
   * Find the best matching typing audio clip and return both the SFX event
   * and the raw keystroke timing data for driving visual typing cadence.
   *
   * This is the primary entry point used by TypingAnimator — the returned
   * keystrokes array provides the exact timestamps that should be used
   * to pace the visual character typing so it matches the audio.
   *
   * @param text        The text that will be "typed" in the browser
   * @param timeOffset  When this typing starts in the clip (seconds)
   * @returns SfxEvent, keystroke timing data, or null if no clips available
   */
  getTypingSfxWithKeystrokes(
    text: string,
    timeOffset: number
  ): { event: SfxEvent; keystrokes: KeystrokeEvent[] } | null {
    const result = this.getTypingSfx(text, timeOffset);
    if (!result) return null;

    return {
      event: result.event,
      keystrokes: result.keystrokes.keystrokes,
    };
  }

  /**
   * Build a complete SFX timeline for a typing sequence.
   *
   * For longer texts, this chains multiple typing clips together,
   * picking clips that cover subsets of the words.
   */
  buildTypingTimeline(
    text: string,
    startTimeOffset: number
  ): SfxEvent[] {
    return this.buildTypingTimelineWithKeystrokes(text, startTimeOffset)
      .map((c) => c.event);
  }

  /**
   * Build a complete typed timeline with per-chunk keystroke data.
   *
   * Splits the text into word-count-matched chunks, one clip per chunk.
   * Each chunk carries its own event (for audio placement) and keystroke
   * timing array (for driving the visual typing cadence), enabling full
   * audio-driven multi-clip typing across arbitrarily long searches.
   *
   * @param text             The full text that will be typed
   * @param startTimeOffset  Clip-relative start time in seconds
   */
  buildTypingTimelineWithKeystrokes(
    text: string,
    startTimeOffset: number
  ): Array<{ event: SfxEvent; chunkText: string; keystrokes: KeystrokeEvent[] }> {
    if (!this.config.keyboardTyping.enabled || this.typingClips.length === 0) {
      return [];
    }

    const words = text.split(/\s+/).filter(Boolean);
    const chunks: Array<{ event: SfxEvent; chunkText: string; keystrokes: KeystrokeEvent[] }> = [];
    let currentOffset = startTimeOffset;
    let wordsRemaining = [...words];

    while (wordsRemaining.length > 0) {
      const candidateText = wordsRemaining.join(' ');
      const result = this.getTypingSfx(candidateText, currentOffset);

      if (!result) break;

      // Consume as many words as the matched clip covers
      const coveredWords = Math.max(1, result.keystrokes.wordCount);
      const chunkWords = wordsRemaining.slice(0, coveredWords);
      const chunkText = chunkWords.join(' ');

      chunks.push({
        event: result.event,
        chunkText,
        keystrokes: result.keystrokes.keystrokes,
      });

      currentOffset += result.event.durationSeconds;
      wordsRemaining = wordsRemaining.slice(coveredWords);
    }

    return chunks;
  }
}
