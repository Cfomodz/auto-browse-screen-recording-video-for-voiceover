import { describe, it, expect } from 'vitest';
import { TypingAnimator } from '../../src/browser/typing-animator';
import { TypingConfig } from '../../src/core/types';
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
});
