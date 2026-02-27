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

    // Score each clip by how well it matches
    const scored = this.typingClips.map((clip) => {
      let score = 0;

      // Word count similarity (most important)
      const wordDiff = Math.abs(clip.wordCount - wordCount);
      score -= wordDiff * 10;

      // Character count similarity
      const charDiff = Math.abs(clip.typedText.length - charCount);
      score -= charDiff;

      // Prefer clips without excessive backspaces for clean text
      score -= clip.backspaceSequences * 2;

      return { clip, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    if (!best) return null;

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
   * For longer texts, this may chain multiple typing clips together,
   * picking clips that cover subsets of the words.
   */
  buildTypingTimeline(
    text: string,
    startTimeOffset: number
  ): SfxEvent[] {
    if (!this.config.keyboardTyping.enabled || this.typingClips.length === 0) {
      return [];
    }

    const words = text.split(/\s+/).filter(Boolean);
    const events: SfxEvent[] = [];
    let currentOffset = startTimeOffset;
    let wordsRemaining = [...words];

    while (wordsRemaining.length > 0) {
      // Try to find a clip that covers as many remaining words as possible
      const chunk = wordsRemaining.join(' ');
      const result = this.getTypingSfx(chunk, currentOffset);

      if (!result) {
        // No clips available — skip remaining words
        break;
      }

      events.push(result.event);
      currentOffset += result.event.durationSeconds;

      // Consume words covered by this clip
      const coveredWords = Math.max(1, result.keystrokes.wordCount);
      wordsRemaining = wordsRemaining.slice(coveredWords);
    }

    return events;
  }
}
