import { describe, it, expect } from 'vitest';
import { KeystrokeEvent } from '../../src/core/types';

/**
 * We test the pure-logic functions from extract-clips.ts by re-implementing
 * them here (they're not exported). This validates the segmentation and replay
 * logic in isolation without needing ffmpeg or real files.
 */

/** Segment keystrokes by idle gap (matching extract-clips.ts logic). */
function segmentByIdle(keystrokes: KeystrokeEvent[], idleMs: number): KeystrokeEvent[][] {
  if (keystrokes.length === 0) return [];
  const segments: KeystrokeEvent[][] = [];
  let current: KeystrokeEvent[] = [keystrokes[0]];

  for (let i = 1; i < keystrokes.length; i++) {
    const gap = keystrokes[i].timestampMs - keystrokes[i - 1].timestampMs;
    if (gap >= idleMs) {
      if (current.length > 0) segments.push(current);
      current = [keystrokes[i]];
    } else {
      current.push(keystrokes[i]);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** Replay keystrokes to compute typed text and backspace stats (matching extract-clips.ts). */
function replayKeystrokes(keystrokes: KeystrokeEvent[]): {
  typedText: string;
  backspaceSequences: number;
  maxConsecutiveBackspaces: number;
} {
  let typedText = '';
  let backspaceSequences = 0;
  let maxConsecutiveBackspaces = 0;
  let currentBackspaceRun = 0;

  for (const ks of keystrokes) {
    if (ks.key === 'backspace') {
      typedText = typedText.slice(0, -1);
      currentBackspaceRun++;
      if (currentBackspaceRun === 1) backspaceSequences++;
      maxConsecutiveBackspaces = Math.max(maxConsecutiveBackspaces, currentBackspaceRun);
    } else if (ks.key === 'space') {
      typedText += ' ';
      currentBackspaceRun = 0;
    } else if (ks.key === 'enter') {
      typedText += '\n';
      currentBackspaceRun = 0;
    } else if (ks.key.length === 1) {
      typedText += ks.key;
      currentBackspaceRun = 0;
    }
  }

  return { typedText, backspaceSequences, maxConsecutiveBackspaces };
}

describe('extract-clips logic', () => {
  describe('segmentByIdle', () => {
    it('returns empty array for empty keystrokes', () => {
      expect(segmentByIdle([], 700)).toEqual([]);
    });

    it('returns one segment when no idle gaps', () => {
      const keystrokes: KeystrokeEvent[] = [
        { key: 'h', timestampMs: 0 },
        { key: 'i', timestampMs: 80 },
        { key: 'space', timestampMs: 200 },
      ];
      const segments = segmentByIdle(keystrokes, 700);
      expect(segments).toHaveLength(1);
      expect(segments[0]).toHaveLength(3);
    });

    it('splits into two segments at an idle gap', () => {
      const keystrokes: KeystrokeEvent[] = [
        { key: 'h', timestampMs: 0 },
        { key: 'i', timestampMs: 80 },
        // 1-second gap
        { key: 'b', timestampMs: 1080 },
        { key: 'y', timestampMs: 1160 },
      ];
      const segments = segmentByIdle(keystrokes, 700);
      expect(segments).toHaveLength(2);
      expect(segments[0]).toHaveLength(2);
      expect(segments[1]).toHaveLength(2);
    });

    it('handles exactly the idle threshold (gap = idleMs)', () => {
      const keystrokes: KeystrokeEvent[] = [
        { key: 'a', timestampMs: 0 },
        { key: 'b', timestampMs: 700 }, // exactly 700ms gap
      ];
      const segments = segmentByIdle(keystrokes, 700);
      expect(segments).toHaveLength(2);
    });

    it('handles gap just under threshold as same segment', () => {
      const keystrokes: KeystrokeEvent[] = [
        { key: 'a', timestampMs: 0 },
        { key: 'b', timestampMs: 699 }, // just under 700ms
      ];
      const segments = segmentByIdle(keystrokes, 700);
      expect(segments).toHaveLength(1);
    });

    it('handles single keystroke', () => {
      const keystrokes: KeystrokeEvent[] = [
        { key: 'a', timestampMs: 0 },
      ];
      const segments = segmentByIdle(keystrokes, 700);
      expect(segments).toHaveLength(1);
      expect(segments[0]).toHaveLength(1);
    });

    it('creates multiple segments with multiple gaps', () => {
      const keystrokes: KeystrokeEvent[] = [
        { key: 'a', timestampMs: 0 },
        { key: 'b', timestampMs: 80 },
        // gap 1
        { key: 'c', timestampMs: 1000 },
        // gap 2
        { key: 'd', timestampMs: 2000 },
        { key: 'e', timestampMs: 2080 },
      ];
      const segments = segmentByIdle(keystrokes, 700);
      expect(segments).toHaveLength(3);
    });
  });

  describe('replayKeystrokes', () => {
    it('replays simple text', () => {
      const keystrokes: KeystrokeEvent[] = [
        { key: 'h', timestampMs: 0 },
        { key: 'e', timestampMs: 80 },
        { key: 'l', timestampMs: 160 },
        { key: 'l', timestampMs: 240 },
        { key: 'o', timestampMs: 320 },
      ];
      const result = replayKeystrokes(keystrokes);
      expect(result.typedText).toBe('hello');
      expect(result.backspaceSequences).toBe(0);
      expect(result.maxConsecutiveBackspaces).toBe(0);
    });

    it('handles spaces', () => {
      const keystrokes: KeystrokeEvent[] = [
        { key: 'h', timestampMs: 0 },
        { key: 'i', timestampMs: 80 },
        { key: 'space', timestampMs: 160 },
        { key: 'y', timestampMs: 240 },
        { key: 'o', timestampMs: 320 },
      ];
      const result = replayKeystrokes(keystrokes);
      expect(result.typedText).toBe('hi yo');
    });

    it('handles enter as newline', () => {
      const keystrokes: KeystrokeEvent[] = [
        { key: 'a', timestampMs: 0 },
        { key: 'enter', timestampMs: 80 },
        { key: 'b', timestampMs: 160 },
      ];
      const result = replayKeystrokes(keystrokes);
      expect(result.typedText).toBe('a\nb');
    });

    it('handles backspace corrections', () => {
      const keystrokes: KeystrokeEvent[] = [
        { key: 'h', timestampMs: 0 },
        { key: 'r', timestampMs: 80 }, // mistake
        { key: 'backspace', timestampMs: 200 },
        { key: 'e', timestampMs: 280 },
        { key: 'l', timestampMs: 360 },
        { key: 'l', timestampMs: 440 },
        { key: 'o', timestampMs: 520 },
      ];
      const result = replayKeystrokes(keystrokes);
      expect(result.typedText).toBe('hello');
      expect(result.backspaceSequences).toBe(1);
      expect(result.maxConsecutiveBackspaces).toBe(1);
    });

    it('tracks multiple consecutive backspaces', () => {
      const keystrokes: KeystrokeEvent[] = [
        { key: 'a', timestampMs: 0 },
        { key: 'b', timestampMs: 80 },
        { key: 'c', timestampMs: 160 },
        { key: 'backspace', timestampMs: 300 },
        { key: 'backspace', timestampMs: 340 },
        { key: 'backspace', timestampMs: 380 },
        { key: 'x', timestampMs: 500 },
      ];
      const result = replayKeystrokes(keystrokes);
      expect(result.typedText).toBe('x');
      expect(result.backspaceSequences).toBe(1);
      expect(result.maxConsecutiveBackspaces).toBe(3);
    });

    it('tracks separate backspace sequences', () => {
      const keystrokes: KeystrokeEvent[] = [
        { key: 'a', timestampMs: 0 },
        { key: 'backspace', timestampMs: 100 },
        { key: 'b', timestampMs: 200 },
        { key: 'backspace', timestampMs: 300 },
        { key: 'c', timestampMs: 400 },
      ];
      const result = replayKeystrokes(keystrokes);
      expect(result.typedText).toBe('c');
      expect(result.backspaceSequences).toBe(2);
      expect(result.maxConsecutiveBackspaces).toBe(1);
    });

    it('handles backspace on empty string gracefully', () => {
      const keystrokes: KeystrokeEvent[] = [
        { key: 'backspace', timestampMs: 0 },
        { key: 'a', timestampMs: 80 },
      ];
      const result = replayKeystrokes(keystrokes);
      expect(result.typedText).toBe('a');
    });

    it('ignores multi-char keys (like "shift")', () => {
      const keystrokes: KeystrokeEvent[] = [
        { key: 'shift', timestampMs: 0 },
        { key: 'H', timestampMs: 50 },
        { key: 'i', timestampMs: 130 },
      ];
      const result = replayKeystrokes(keystrokes);
      // 'shift' has length > 1 and isn't 'space'/'enter'/'backspace' → ignored
      expect(result.typedText).toBe('Hi');
    });

    it('returns empty text for no keystrokes', () => {
      const result = replayKeystrokes([]);
      expect(result.typedText).toBe('');
      expect(result.backspaceSequences).toBe(0);
    });
  });
});
