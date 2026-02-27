import * as fs from 'fs';
import * as path from 'path';
import { SfxConfig, SfxEvent, KeystrokeEvent, TypingClipMeta } from '../core/types';
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

  private clickSamples: string[] = [];
  private typingClips: TypingClipMeta[] = [];
  private lastClickIndex = 0;

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
    // Load click samples
    if (this.config.mouseClick.enabled) {
      const clickDir = path.join(this.config.libraryPath, this.config.mouseClick.samplesDir);
      this.clickSamples = this.loadAudioFiles(clickDir);
      this.logger.info(`Loaded ${this.clickSamples.length} click samples from ${clickDir}`);
    }

    // Load typing clips with their metadata
    if (this.config.keyboardTyping.enabled) {
      const typingDir = path.join(this.config.libraryPath, this.config.keyboardTyping.samplesDir);
      this.typingClips = this.loadTypingClips(typingDir);
      this.logger.info(`Loaded ${this.typingClips.length} typing clips from ${typingDir}`);
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

  /** Get a click sound effect event at a given time offset. */
  getClickSfx(timeOffset: number): SfxEvent | null {
    if (!this.config.mouseClick.enabled || this.clickSamples.length === 0) {
      return null;
    }

    // Cycle through click samples with some randomness to avoid repetition
    const index = (this.lastClickIndex + 1 + Math.floor(Math.random() * Math.max(1, this.clickSamples.length - 1))) % this.clickSamples.length;
    this.lastClickIndex = index;

    return {
      timeOffset,
      type: 'click',
      audioFile: this.clickSamples[index],
      durationSeconds: 0.3, // Click sounds are typically short
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
