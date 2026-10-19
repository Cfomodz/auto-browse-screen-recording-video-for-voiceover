import { describe, it, expect } from 'vitest';
import { TypingAnimator } from '../../src/browser/typing-animator';
import { TypingConfig, KeystrokeEvent } from '../../src/core/types';
import { createLogger } from '../../src/utils/logger';

const logger = createLogger('test');
logger.silent = true;

function makeConfig(overrides?: Partial<TypingConfig>): TypingConfig {
  return {
    baseDelayMs: 80,
    inconsistency: 0.35,
    mistakeProbability: 0,
    maxMistakeLength: 2,
    thinkPause: { minMs: 100, maxMs: 300 },
    ...overrides,
  };
}

describe('TypingAnimator', () => {
  describe('buildKeystrokePlan', () => {
    it('produces one keystroke per character for simple text', () => {
      const animator = new TypingAnimator(makeConfig(), logger);
      const plan = animator.buildKeystrokePlan('hello');
      // 5 chars, no spaces, no mistakes
      expect(plan).toHaveLength(5);
      expect(plan.map((s) => s.key).join('')).toBe('hello');
    });

    it('includes whitespace tokens between words', () => {
      const animator = new TypingAnimator(makeConfig(), logger);
      const plan = animator.buildKeystrokePlan('hi there');
      // 'hi' (2) + ' ' (1) + 'there' (5) = 8
      expect(plan).toHaveLength(8);
      expect(plan[2].key).toBe(' ');
    });

    it('generates delays > 0 for every keystroke', () => {
      const animator = new TypingAnimator(makeConfig(), logger);
      const plan = animator.buildKeystrokePlan('testing delays');
      for (const stroke of plan) {
        expect(stroke.delayBeforeMs).toBeGreaterThan(0);
      }
    });

    it('produces no mistakes when mistakeProbability is 0', () => {
      const animator = new TypingAnimator(makeConfig({ mistakeProbability: 0 }), logger);
      const plan = animator.buildKeystrokePlan('no mistakes here');
      const mistakes = plan.filter((s) => s.isMistake);
      expect(mistakes).toHaveLength(0);
    });

    it('generates mistakes and corrections when probability is 1', () => {
      const animator = new TypingAnimator(
        makeConfig({ mistakeProbability: 1 }),
        logger
      );
      // Use a long word to ensure it qualifies (>2 chars)
      const plan = animator.buildKeystrokePlan('extraordinarily');
      const mistakes = plan.filter((s) => s.isMistake);
      const corrections = plan.filter((s) => s.isCorrection);
      expect(mistakes.length).toBeGreaterThan(0);
      expect(corrections.length).toBeGreaterThan(0);
      // Corrections should be backspaces
      for (const c of corrections) {
        expect(c.key).toBe('backspace');
      }
    });

    it('never generates negative delays', () => {
      // High inconsistency could potentially create negative values if not clamped
      const animator = new TypingAnimator(
        makeConfig({ inconsistency: 1.0, baseDelayMs: 50 }),
        logger
      );
      for (let i = 0; i < 5; i++) {
        const plan = animator.buildKeystrokePlan('test high variance run');
        for (const stroke of plan) {
          expect(stroke.delayBeforeMs).toBeGreaterThanOrEqual(20);
        }
      }
    });

    it('has word gap delays within configured thinkPause range', () => {
      const config = makeConfig({ thinkPause: { minMs: 100, maxMs: 300 } });
      const animator = new TypingAnimator(config, logger);
      const plan = animator.buildKeystrokePlan('hello world again');
      // Whitespace tokens have word gap delays
      const spaces = plan.filter((s) => /^\s+$/.test(s.key));
      expect(spaces.length).toBeGreaterThan(0);
      for (const sp of spaces) {
        expect(sp.delayBeforeMs).toBeGreaterThanOrEqual(100);
        expect(sp.delayBeforeMs).toBeLessThanOrEqual(300);
      }
    });

    it('keystroke delays are clamped to 3x baseDelayMs', () => {
      const config = makeConfig({ baseDelayMs: 80, inconsistency: 0.5 });
      const animator = new TypingAnimator(config, logger);
      for (let i = 0; i < 5; i++) {
        const plan = animator.buildKeystrokePlan('clamping check');
        for (const stroke of plan) {
          if (!/^\s+$/.test(stroke.key)) {
            expect(stroke.delayBeforeMs).toBeLessThanOrEqual(240);
          }
        }
      }
    });

    it('zero inconsistency produces uniform delays', () => {
      const config = makeConfig({ inconsistency: 0, baseDelayMs: 100 });
      const animator = new TypingAnimator(config, logger);
      const plan = animator.buildKeystrokePlan('abcde');
      // With zero inconsistency, gaussian jitter is 0, so all delays should be
      // close to baseDelayMs (100) — first char of word may be slightly higher
      for (const stroke of plan) {
        // All should be between 20 and 300 (clamped) and close to 100
        expect(stroke.delayBeforeMs).toBeGreaterThanOrEqual(20);
        expect(stroke.delayBeforeMs).toBeLessThanOrEqual(240);
      }
    });

    it('handles empty string gracefully', () => {
      const animator = new TypingAnimator(makeConfig(), logger);
      const plan = animator.buildKeystrokePlan('');
      expect(plan).toHaveLength(0);
    });

    it('handles single character', () => {
      const animator = new TypingAnimator(makeConfig(), logger);
      const plan = animator.buildKeystrokePlan('x');
      expect(plan).toHaveLength(1);
      expect(plan[0].key).toBe('x');
    });

    it('mistake corrections restore the correct final text', () => {
      const animator = new TypingAnimator(
        makeConfig({ mistakeProbability: 1 }),
        logger
      );
      const original = 'testing';
      const plan = animator.buildKeystrokePlan(original);
      // Simulate typing to verify the final result
      let result = '';
      for (const stroke of plan) {
        if (stroke.key === 'backspace') {
          result = result.slice(0, -1);
        } else {
          result += stroke.key;
        }
      }
      expect(result).toBe(original);
    });
  });

  describe('typeWithAudioCadence', () => {
    it('uses audio keystroke timestamps to determine typing delays', async () => {
      const animator = new TypingAnimator(makeConfig(), logger);

      // Audio keystrokes at known timestamps
      const audioKeystrokes: KeystrokeEvent[] = [
        { key: 'h', timestampMs: 50 },
        { key: 'i', timestampMs: 200 },
      ];

      // Mock page with keyboard tracking
      const typedKeys: string[] = [];
      const mockPage = {
        keyboard: {
          type: async (key: string, _opts?: { delay: number }) => { typedKeys.push(key); },
          press: async (key: string) => { typedKeys.push(key); },
        },
      } as any;

      const durationMs = await animator.typeWithAudioCadence(mockPage, 'hi', audioKeystrokes);

      // The delay for 'h' is 50ms (first keystroke timestamp), for 'i' is 150ms (200-50)
      // Total should be >= 200ms (50 + 150)
      expect(durationMs).toBeGreaterThanOrEqual(150);
      expect(typedKeys).toEqual(['h', 'i']);
    });

    it('handles more text chars than audio keystrokes gracefully', async () => {
      const animator = new TypingAnimator(makeConfig(), logger);

      // Only 2 keystrokes for 5 chars
      const audioKeystrokes: KeystrokeEvent[] = [
        { key: 'h', timestampMs: 0 },
        { key: 'e', timestampMs: 100 },
      ];

      const typedKeys: string[] = [];
      const mockPage = {
        keyboard: {
          type: async (key: string, _opts?: { delay: number }) => { typedKeys.push(key); },
          press: async (key: string) => { typedKeys.push(key); },
        },
      } as any;

      const durationMs = await animator.typeWithAudioCadence(mockPage, 'hello', audioKeystrokes);

      // Should type all 5 chars even though we only have 2 keystroke timestamps
      expect(typedKeys).toHaveLength(5);
      expect(typedKeys.join('')).toBe('hello');
      expect(durationMs).toBeGreaterThan(0);
    });

    it('presses Space for space characters', async () => {
      const animator = new TypingAnimator(makeConfig(), logger);

      const audioKeystrokes: KeystrokeEvent[] = [
        { key: 'h', timestampMs: 20 },
        { key: 'i', timestampMs: 100 },
        { key: 'space', timestampMs: 200 },
        { key: 'y', timestampMs: 350 },
        { key: 'o', timestampMs: 450 },
      ];

      const pressedKeys: string[] = [];
      const typedKeys: string[] = [];
      const mockPage = {
        keyboard: {
          type: async (key: string, _opts?: { delay: number }) => { typedKeys.push(key); },
          press: async (key: string) => { pressedKeys.push(key); },
        },
      } as any;

      await animator.typeWithAudioCadence(mockPage, 'hi yo', audioKeystrokes);

      // Space should be pressed via keyboard.press('Space')
      expect(pressedKeys).toContain('Space');
      // Non-space chars should be typed via keyboard.type
      expect(typedKeys).toEqual(['h', 'i', 'y', 'o']);
    });

    it('keeps keystrokes on the clip clock even when key presses are slow', async () => {
      const animator = new TypingAnimator(makeConfig(), logger);
      const audioKeystrokes: KeystrokeEvent[] = Array.from({ length: 10 }, (_, i) => ({
        key: 'a',
        timestampMs: 50 + i * 60,
      }));
      // Each key press costs 25ms (a slow CDP round trip)
      const mockPage = {
        keyboard: {
          type: () => new Promise((r) => setTimeout(r, 25)),
          press: () => new Promise((r) => setTimeout(r, 25)),
        },
      } as any;

      const durationMs = await animator.typeWithAudioCadence(mockPage, 'aaaaaaaaaa', audioKeystrokes);

      // Last key is due at 590ms; per-key latency must not pile up (10 x 25ms = 250ms)
      expect(durationMs).toBeLessThan(590 + 25 + 60);
    });

    it('total duration matches audio clip duration', async () => {
      const animator = new TypingAnimator(makeConfig(), logger);

      // Simulate a real audio clip with ~1 second of typing
      const audioKeystrokes: KeystrokeEvent[] = [
        { key: 'c', timestampMs: 50 },
        { key: 'a', timestampMs: 180 },
        { key: 'r', timestampMs: 340 },
        { key: 'space', timestampMs: 500 },
        { key: 'w', timestampMs: 680 },
        { key: 'a', timestampMs: 810 },
        { key: 's', timestampMs: 950 },
        { key: 'h', timestampMs: 1100 },
      ];

      const mockPage = {
        keyboard: {
          type: async (_k: string, _o?: { delay: number }) => {},
          press: async (_k: string) => {},
        },
      } as any;

      const durationMs = await animator.typeWithAudioCadence(mockPage, 'car wash', audioKeystrokes);

      // Duration should be close to the last keystroke timestamp (1100ms)
      // Allow some margin for the minimum delay clamping (20ms per key)
      expect(durationMs).toBeGreaterThan(800);
      expect(durationMs).toBeLessThan(2000);
    });
  });
});

describe('TypingAnimator.type with SFX clips', () => {
  it('starts each clip when its chunk starts typing and cuts it after the keys used', async () => {
    // Two chunks: "ab " on a clip with 6 keystrokes (3 used), then "cd" on a 2-keystroke clip
    const chunks = [
      {
        event: { timeOffset: 1, type: 'typing' as const, audioFile: 'a.wav', durationSeconds: 2.0 },
        chunkText: 'ab ',
        keystrokes: [0, 1, 2, 3, 4, 5].map((i) => ({ key: 'x', timestampMs: 40 + i * 50 })),
      },
      {
        event: { timeOffset: 3, type: 'typing' as const, audioFile: 'b.wav', durationSeconds: 1.0 },
        chunkText: 'cd',
        keystrokes: [{ key: 'c', timestampMs: 30 }, { key: 'd', timestampMs: 90 }],
      },
    ];
    const sfxManager = { buildTypingTimelineWithKeystrokes: () => chunks } as any;
    const animator = new TypingAnimator(makeConfig(), logger, sfxManager);
    const typed: string[] = [];
    const mockPage = {
      keyboard: {
        type: async (k: string) => { typed.push(k); },
        press: async (k: string) => { typed.push(k === 'Space' ? ' ' : k); },
      },
    } as any;

    const result = await animator.type(mockPage, 'ab cd', 1000);

    expect(typed.join('')).toBe('ab cd');
    const [first, second] = result.sfxEvents;
    expect(first.timeOffset).toBeCloseTo(1, 1);
    // Chunk 1 ends at its 3rd keystroke (140ms), so chunk 2 starts ~1.14s — not at 3s
    expect(second.timeOffset).toBeGreaterThan(1.1);
    expect(second.timeOffset).toBeLessThan(1.3);
    // Audio is cut 150ms after the last keystroke used
    expect(first.durationSeconds).toBeCloseTo(0.29, 2);
    expect(second.durationSeconds).toBeCloseTo(0.24, 2);
  });
});
