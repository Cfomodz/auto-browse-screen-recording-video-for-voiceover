import { Page } from 'puppeteer-core';
import { TypingConfig, SfxEvent, KeystrokeEvent } from '../core/types';
import { SfxManager } from '../sfx/manager';
import { delay } from '../utils/timing';
import { Logger } from '../utils/logger';

/**
 * Keystroke plan entry — what we're going to type and when.
 * Built before execution so we can match audio clips to the sequence.
 */
interface KeystrokePlan {
  key: string;
  delayBeforeMs: number;
  isMistake: boolean;
  isCorrection: boolean; // backspace to fix a mistake
}

/**
 * Realistic typing animator with Kdenlive-style inconsistency.
 *
 * Models the timing patterns of real human typing:
 * - Base speed with gaussian-distributed variance (the "inconsistency" knob)
 * - Longer pauses between words (thinking)
 * - Occasional typos followed by backspace corrections
 * - Burst speed for familiar short words, slower for unusual words
 *
 * When SFX is enabled, the audio clip is selected first and its real
 * keystroke timestamps drive the cadence of the visual typing — what
 * you see on screen matches what you hear in the audio.
 */
export class TypingAnimator {
  private config: TypingConfig;
  private sfxManager: SfxManager | null;
  private logger: Logger;

  constructor(config: TypingConfig, logger: Logger, sfxManager?: SfxManager) {
    this.config = config;
    this.logger = logger;
    this.sfxManager = sfxManager ?? null;
  }

  /**
   * Type a string into the current page with realistic animation.
   *
   * When SFX typing clips are available, the audio clip is selected
   * first and its keystroke timestamps drive the visual typing cadence.
   * Each character is typed at the time the corresponding keystroke
   * was heard in the recording, creating a 1:1 match between the
   * visual typing and the audio.
   *
   * When no SFX clips are available, falls back to the built-in
   * keystroke plan with gaussian-distributed timing.
   *
   * @param page           Puppeteer page
   * @param text           Text to type
   * @param clipTimeOffset Current time offset into the recording clip (for SFX sync)
   * @returns Object with duration and SFX events generated
   */
  async type(
    page: Page,
    text: string,
    clipTimeOffset: number = 0
  ): Promise<{ durationMs: number; sfxEvents: SfxEvent[] }> {
    const sfxEvents: SfxEvent[] = [];

    // Try audio-driven typing first: select SFX clips, then use their
    // keystroke timestamps to drive the visual cadence
    if (this.sfxManager) {
      const audioResult = this.sfxManager.getTypingSfxWithKeystrokes(text, clipTimeOffset / 1000);
      if (audioResult && audioResult.keystrokes.length > 0) {
        sfxEvents.push(audioResult.event);
        const durationMs = await this.typeWithAudioCadence(
          page,
          text,
          audioResult.keystrokes
        );
        this.logger.info(
          `Audio-driven typing: ${text.length} chars in ${(durationMs / 1000).toFixed(1)}s`
        );
        return { durationMs, sfxEvents };
      }
    }

    // Fallback: use the built-in keystroke plan (no audio)
    const plan = this.buildKeystrokePlan(text);
    let totalMs = 0;
    for (const stroke of plan) {
      await delay(stroke.delayBeforeMs);
      totalMs += stroke.delayBeforeMs;

      if (stroke.key === 'backspace') {
        await page.keyboard.press('Backspace');
      } else {
        await page.keyboard.type(stroke.key, { delay: 0 });
      }
    }

    this.logger.info(
      `Typed ${text.length} chars in ${(totalMs / 1000).toFixed(1)}s ` +
      `(${plan.filter((s) => s.isMistake).length} mistakes, fallback timing)`
    );

    return { durationMs: totalMs, sfxEvents };
  }

  /**
   * Type characters using the audio clip's keystroke timestamps for cadence.
   *
   * Maps each character of `text` to a keystroke event from the audio clip,
   * using the time deltas between consecutive keystrokes as the delay between
   * typing each character. This creates a 1:1 correspondence between the
   * visual typing and the audio.
   *
   * @returns Total duration in milliseconds
   */
  async typeWithAudioCadence(
    page: Page,
    text: string,
    audioKeystrokes: KeystrokeEvent[]
  ): Promise<number> {
    const textChars = text.split('');
    let totalMs = 0;

    for (let i = 0; i < textChars.length; i++) {
      // Compute delay from the audio keystroke timestamps
      let delayMs: number;
      if (i < audioKeystrokes.length) {
        if (i === 0) {
          // First keystroke: use the timestamp directly as initial delay
          delayMs = Math.max(audioKeystrokes[0].timestampMs, 20);
        } else {
          // Subsequent keystrokes: use delta between consecutive timestamps
          delayMs = Math.max(
            audioKeystrokes[i].timestampMs - audioKeystrokes[i - 1].timestampMs,
            20
          );
        }
      } else {
        // More text chars than audio keystrokes: use average cadence from clip
        const avgDelay = audioKeystrokes.length > 1
          ? audioKeystrokes[audioKeystrokes.length - 1].timestampMs / (audioKeystrokes.length - 1)
          : this.config.baseDelayMs;
        delayMs = avgDelay;
      }

      await delay(delayMs);
      totalMs += delayMs;

      const char = textChars[i];
      if (char === ' ') {
        await page.keyboard.press('Space');
      } else {
        await page.keyboard.type(char, { delay: 0 });
      }
    }

    return totalMs;
  }

  /**
   * Build a keystroke plan with realistic timing, mistakes, and corrections.
   *
   * The inconsistency parameter works like Kdenlive's typewriter inconsistency:
   * 0 = perfectly even timing, 1 = highly variable (human-like)
   */
  buildKeystrokePlan(text: string): KeystrokePlan[] {
    const plan: KeystrokePlan[] = [];
    const words = text.split(/(\s+)/); // Preserve whitespace tokens

    for (let wi = 0; wi < words.length; wi++) {
      const word = words[wi];
      const isWhitespace = /^\s+$/.test(word);

      if (isWhitespace) {
        // Space/whitespace — slight pause
        plan.push({
          key: word,
          delayBeforeMs: this.wordGapDelay(),
          isMistake: false,
          isCorrection: false,
        });
        continue;
      }

      // Decide if we make a typo in this word
      const shouldMistake =
        word.length > 2 && Math.random() < this.config.mistakeProbability;

      if (shouldMistake) {
        const mistakeResult = this.planMistake(word);
        plan.push(...mistakeResult);
      } else {
        // Type the word normally, character by character
        for (let i = 0; i < word.length; i++) {
          plan.push({
            key: word[i],
            delayBeforeMs: this.keystrokeDelay(i === 0 && wi > 0),
            isMistake: false,
            isCorrection: false,
          });
        }
      }
    }

    return plan;
  }

  /**
   * Plan a typing mistake: type some correct chars, then wrong chars,
   * then backspaces, then the correct chars.
   */
  private planMistake(word: string): KeystrokePlan[] {
    const plan: KeystrokePlan[] = [];

    // How far into the word before the mistake
    const correctPrefix = Math.max(1, Math.floor(Math.random() * (word.length - 1)));

    // Type correct prefix
    for (let i = 0; i < correctPrefix; i++) {
      plan.push({
        key: word[i],
        delayBeforeMs: this.keystrokeDelay(i === 0),
        isMistake: false,
        isCorrection: false,
      });
    }

    // Type wrong characters (1 to maxMistakeLength)
    const mistakeLen = 1 + Math.floor(Math.random() * Math.min(
      this.config.maxMistakeLength,
      word.length - correctPrefix
    ));

    for (let i = 0; i < mistakeLen; i++) {
      // Pick a random character near the correct one on the keyboard
      const correctChar = word[correctPrefix + i] || word[correctPrefix];
      plan.push({
        key: this.nearbyKey(correctChar),
        delayBeforeMs: this.keystrokeDelay(false),
        isMistake: true,
        isCorrection: false,
      });
    }

    // Brief pause — the "oh I made a mistake" moment
    const pauseMs = 150 + Math.random() * 300;

    // Backspaces to correct — slightly faster than normal typing (rapid correction)
    for (let i = 0; i < mistakeLen; i++) {
      plan.push({
        key: 'backspace',
        delayBeforeMs: i === 0 ? pauseMs : 40 + Math.random() * 60,
        isMistake: false,
        isCorrection: true,
      });
    }

    // Type the rest of the word correctly
    for (let i = correctPrefix; i < word.length; i++) {
      plan.push({
        key: word[i],
        delayBeforeMs: this.keystrokeDelay(false),
        isMistake: false,
        isCorrection: false,
      });
    }

    return plan;
  }

  /**
   * Compute delay before a keystroke with Kdenlive-style inconsistency.
   *
   * Uses a gaussian-like distribution centered on baseDelayMs:
   * - inconsistency=0: always exactly baseDelayMs
   * - inconsistency=0.5: moderate variation
   * - inconsistency=1.0: high variation (very human)
   */
  private keystrokeDelay(isFirstCharOfWord: boolean): number {
    const base = this.config.baseDelayMs;
    const variance = this.config.inconsistency;

    // Box-Muller transform for gaussian random
    const u1 = Math.random();
    const u2 = Math.random();
    const gaussian = Math.sqrt(-2 * Math.log(Math.max(u1, 0.0001))) * Math.cos(2 * Math.PI * u2);

    // Scale the gaussian by inconsistency and base delay
    const jitter = gaussian * variance * base * 0.5;
    let ms = base + jitter;

    // First character of a word is slightly slower (finger repositioning)
    if (isFirstCharOfWord) {
      ms *= 1.1 + Math.random() * 0.2;
    }

    // Clamp to reasonable bounds
    return Math.max(20, Math.min(ms, base * 3));
  }

  /** Compute the delay between words (thinking/space gap). */
  private wordGapDelay(): number {
    const { minMs, maxMs } = this.config.thinkPause;
    return minMs + Math.random() * (maxMs - minMs);
  }

  /** Return a key that's physically near the given key on a QWERTY keyboard. */
  private nearbyKey(char: string): string {
    const adjacency: Record<string, string> = {
      q: 'wa', w: 'qeas', e: 'wrds', r: 'etfg', t: 'ryfg',
      y: 'tuhg', u: 'yijh', i: 'uokj', o: 'iplk', p: 'ol',
      a: 'qwsz', s: 'awedxz', d: 'serfcx', f: 'drtgvc',
      g: 'ftyhbv', h: 'gyujnb', j: 'huiknm', k: 'jiolm',
      l: 'kop', z: 'asx', x: 'zsdc', c: 'xdfv', v: 'cfgb',
      b: 'vghn', n: 'bhjm', m: 'njk',
    };

    const lower = char.toLowerCase();
    const neighbors = adjacency[lower];
    if (!neighbors) return char;

    const picked = neighbors[Math.floor(Math.random() * neighbors.length)];
    return char === char.toUpperCase() ? picked.toUpperCase() : picked;
  }
}
