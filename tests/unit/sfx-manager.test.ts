import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SfxManager } from '../../src/sfx/manager';
import { SfxConfig, TypingClipMeta } from '../../src/core/types';
import { createLogger } from '../../src/utils/logger';
import { makeTempDir, generateTestTone } from '../helpers';

const logger = createLogger('test');
logger.silent = true;

function makeSfxConfig(
  libraryPath: string,
  overrides?: Partial<SfxConfig>
): SfxConfig {
  return {
    enabled: true,
    libraryPath,
    volume: 0.4,
    mouseClick: {
      enabled: true,
      samplesDir: 'clicks',
    },
    keyboardTyping: {
      enabled: true,
      samplesDir: 'typing',
    },
    ...overrides,
  };
}

function writeClipJson(
  dir: string,
  name: string,
  meta: TypingClipMeta
): void {
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(meta));
}

describe('SfxManager', () => {
  let tmpDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const tmp = makeTempDir('sfx-test-');
    tmpDir = tmp.dir;
    cleanup = tmp.cleanup;
    // Create subdirectories
    fs.mkdirSync(path.join(tmpDir, 'clicks'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'typing'), { recursive: true });
  });

  afterEach(() => cleanup());

  describe('loading', () => {
    it('loads click samples from the clicks directory', () => {
      // Create some click WAV files
      generateTestTone(path.join(tmpDir, 'clicks', 'click1.wav'), { durationSec: 0.2 });
      generateTestTone(path.join(tmpDir, 'clicks', 'click2.wav'), { durationSec: 0.2 });

      const manager = new SfxManager(makeSfxConfig(tmpDir), logger);
      expect(manager.enabled).toBe(true);
      // getClickSfx should return events since we have samples
      const sfx = manager.getClickSfx(0);
      expect(sfx).not.toBeNull();
      expect(sfx!.type).toBe('click');
      expect(sfx!.audioFile).toContain('click');
    });

    it('loads typing clips from json sidecars', () => {
      // Create a typing clip with audio + json
      const audioPath = 'clip_001.wav';
      generateTestTone(path.join(tmpDir, 'typing', audioPath), { durationSec: 1 });
      writeClipJson(path.join(tmpDir, 'typing'), 'clip_001', {
        audioFile: audioPath,
        durationMs: 1000,
        typedText: 'hello',
        wordCount: 1,
        backspaceSequences: 0,
        maxConsecutiveBackspaces: 0,
        keystrokes: [
          { key: 'h', timestampMs: 0 },
          { key: 'e', timestampMs: 80 },
          { key: 'l', timestampMs: 160 },
          { key: 'l', timestampMs: 240 },
          { key: 'o', timestampMs: 320 },
        ],
      });

      const manager = new SfxManager(makeSfxConfig(tmpDir), logger);
      const result = manager.getTypingSfx('hello', 0);
      expect(result).not.toBeNull();
      expect(result!.event.type).toBe('typing');
    });

    it('returns null for clicks when disabled', () => {
      const config = makeSfxConfig(tmpDir, {
        mouseClick: { enabled: false, samplesDir: 'clicks' },
      });
      const manager = new SfxManager(config, logger);
      expect(manager.getClickSfx(0)).toBeNull();
    });

    it('returns null when SFX globally disabled', () => {
      const config = makeSfxConfig(tmpDir, { enabled: false });
      const manager = new SfxManager(config, logger);
      expect(manager.enabled).toBe(false);
      expect(manager.getClickSfx(0)).toBeNull();
    });
  });

  describe('getClickSfx', () => {
    it('cycles through click samples without repeating immediately', () => {
      generateTestTone(path.join(tmpDir, 'clicks', 'click1.wav'), { durationSec: 0.2 });
      generateTestTone(path.join(tmpDir, 'clicks', 'click2.wav'), { durationSec: 0.2 });
      generateTestTone(path.join(tmpDir, 'clicks', 'click3.wav'), { durationSec: 0.2 });

      const manager = new SfxManager(makeSfxConfig(tmpDir), logger);
      const sfx1 = manager.getClickSfx(0);
      const sfx2 = manager.getClickSfx(0.5);

      expect(sfx1).not.toBeNull();
      expect(sfx2).not.toBeNull();
      // With 3 samples, consecutive calls should vary
      expect(sfx1!.audioFile).not.toBe(sfx2!.audioFile);
    });

    it('sets the time offset correctly', () => {
      generateTestTone(path.join(tmpDir, 'clicks', 'click1.wav'), { durationSec: 0.2 });

      const manager = new SfxManager(makeSfxConfig(tmpDir), logger);
      const sfx = manager.getClickSfx(5.5);
      expect(sfx!.timeOffset).toBe(5.5);
    });
  });

  describe('getTypingSfx matching', () => {
    beforeEach(() => {
      // Set up clips with varying word counts
      const clips: Array<{ name: string; meta: TypingClipMeta }> = [
        {
          name: 'clip_001',
          meta: {
            audioFile: 'clip_001.wav',
            durationMs: 500,
            typedText: 'ai',
            wordCount: 1,
            backspaceSequences: 0,
            maxConsecutiveBackspaces: 0,
            keystrokes: [],
          },
        },
        {
          name: 'clip_002',
          meta: {
            audioFile: 'clip_002.wav',
            durationMs: 1500,
            typedText: 'neural network',
            wordCount: 2,
            backspaceSequences: 0,
            maxConsecutiveBackspaces: 0,
            keystrokes: [],
          },
        },
        {
          name: 'clip_003',
          meta: {
            audioFile: 'clip_003.wav',
            durationMs: 3000,
            typedText: 'deep learning model training',
            wordCount: 4,
            backspaceSequences: 1,
            maxConsecutiveBackspaces: 2,
            keystrokes: [],
          },
        },
      ];

      for (const { name, meta } of clips) {
        generateTestTone(path.join(tmpDir, 'typing', `${name}.wav`), { durationSec: meta.durationMs / 1000 });
        writeClipJson(path.join(tmpDir, 'typing'), name, meta);
      }
    });

    it('prefers clips with matching word count', () => {
      const manager = new SfxManager(makeSfxConfig(tmpDir), logger);
      const result = manager.getTypingSfx('hello world', 0);
      expect(result).not.toBeNull();
      // 'hello world' is 2 words — should match clip_002 (2 words)
      expect(result!.keystrokes.wordCount).toBe(2);
    });

    it('selects single-word clip for single-word input', () => {
      const manager = new SfxManager(makeSfxConfig(tmpDir), logger);
      const result = manager.getTypingSfx('test', 0);
      expect(result).not.toBeNull();
      expect(result!.keystrokes.wordCount).toBe(1);
    });

    it('returns correct time offset', () => {
      const manager = new SfxManager(makeSfxConfig(tmpDir), logger);
      const result = manager.getTypingSfx('test', 3.5);
      expect(result!.event.timeOffset).toBe(3.5);
    });
  });

  describe('getTypingSfxWithKeystrokes', () => {
    beforeEach(() => {
      const meta: TypingClipMeta = {
        audioFile: 'clip_with_ks.wav',
        durationMs: 1000,
        typedText: 'hello world',
        wordCount: 2,
        backspaceSequences: 0,
        maxConsecutiveBackspaces: 0,
        keystrokes: [
          { key: 'h', timestampMs: 0 },
          { key: 'e', timestampMs: 80 },
          { key: 'l', timestampMs: 160 },
          { key: 'l', timestampMs: 240 },
          { key: 'o', timestampMs: 320 },
          { key: 'space', timestampMs: 450 },
          { key: 'w', timestampMs: 550 },
          { key: 'o', timestampMs: 630 },
          { key: 'r', timestampMs: 710 },
          { key: 'l', timestampMs: 790 },
          { key: 'd', timestampMs: 870 },
        ],
      };
      generateTestTone(path.join(tmpDir, 'typing', 'clip_with_ks.wav'), { durationSec: 1 });
      writeClipJson(path.join(tmpDir, 'typing'), 'clip_with_ks', meta);
    });

    it('returns SFX event with keystroke timing data', () => {
      const manager = new SfxManager(makeSfxConfig(tmpDir), logger);
      const result = manager.getTypingSfxWithKeystrokes('hello world', 0);
      expect(result).not.toBeNull();
      expect(result!.event.type).toBe('typing');
      expect(result!.keystrokes.length).toBeGreaterThan(0);
    });

    it('keystroke timestamps are present and ordered', () => {
      const manager = new SfxManager(makeSfxConfig(tmpDir), logger);
      const result = manager.getTypingSfxWithKeystrokes('hello world', 0);
      expect(result).not.toBeNull();

      const keystrokes = result!.keystrokes;
      expect(keystrokes.length).toBe(11); // 11 chars in "hello world"

      // Timestamps should be monotonically non-decreasing
      for (let i = 1; i < keystrokes.length; i++) {
        expect(keystrokes[i].timestampMs).toBeGreaterThanOrEqual(keystrokes[i - 1].timestampMs);
      }
    });

    it('returns null when SFX is disabled', () => {
      const config = makeSfxConfig(tmpDir, {
        keyboardTyping: { enabled: false, samplesDir: 'typing' },
      });
      const manager = new SfxManager(config, logger);
      const result = manager.getTypingSfxWithKeystrokes('hello', 0);
      expect(result).toBeNull();
    });

    it('sets the correct time offset on the event', () => {
      const manager = new SfxManager(makeSfxConfig(tmpDir), logger);
      const result = manager.getTypingSfxWithKeystrokes('hello world', 2.5);
      expect(result!.event.timeOffset).toBe(2.5);
    });
  });

  describe('buildTypingTimeline', () => {
    beforeEach(() => {
      // Single 2-word clip
      const meta: TypingClipMeta = {
        audioFile: 'clip_001.wav',
        durationMs: 1000,
        typedText: 'hello world',
        wordCount: 2,
        backspaceSequences: 0,
        maxConsecutiveBackspaces: 0,
        keystrokes: [],
      };
      generateTestTone(path.join(tmpDir, 'typing', 'clip_001.wav'), { durationSec: 1 });
      writeClipJson(path.join(tmpDir, 'typing'), 'clip_001', meta);
    });

    it('produces events for multi-word text', () => {
      const manager = new SfxManager(makeSfxConfig(tmpDir), logger);
      const events = manager.buildTypingTimeline('hello world again', 0);
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        expect(e.type).toBe('typing');
        expect(e.durationSeconds).toBeGreaterThan(0);
      }
    });

    it('chains events sequentially with increasing offsets', () => {
      const manager = new SfxManager(makeSfxConfig(tmpDir), logger);
      const events = manager.buildTypingTimeline('one two three four five six', 0);
      for (let i = 1; i < events.length; i++) {
        expect(events[i].timeOffset).toBeGreaterThanOrEqual(events[i - 1].timeOffset);
      }
    });

    it('returns empty array when typing is disabled', () => {
      const config = makeSfxConfig(tmpDir, {
        keyboardTyping: { enabled: false, samplesDir: 'typing' },
      });
      const manager = new SfxManager(config, logger);
      const events = manager.buildTypingTimeline('hello', 0);
      expect(events).toHaveLength(0);
    });

    it('starts from the provided offset', () => {
      const manager = new SfxManager(makeSfxConfig(tmpDir), logger);
      const events = manager.buildTypingTimeline('hello world', 5.0);
      expect(events[0].timeOffset).toBe(5.0);
    });
  });

  describe('buildTypingTimelineWithKeystrokes', () => {
    beforeEach(() => {
      // Single 2-word clip — longer texts must chain multiple chunks
      const meta: TypingClipMeta = {
        audioFile: 'clip_001.wav',
        durationMs: 1000,
        typedText: 'hello world',
        wordCount: 2,
        backspaceSequences: 0,
        maxConsecutiveBackspaces: 0,
        keystrokes: [
          { key: 'h', timestampMs: 0 },
          { key: 'i', timestampMs: 500 },
        ],
      };
      generateTestTone(path.join(tmpDir, 'typing', 'clip_001.wav'), { durationSec: 1 });
      writeClipJson(path.join(tmpDir, 'typing'), 'clip_001', meta);
    });

    it('chunk texts concatenate to exactly the input text (chunk-boundary spaces preserved)', () => {
      const manager = new SfxManager(makeSfxConfig(tmpDir), logger);
      const chunks = manager.buildTypingTimelineWithKeystrokes('car wash near me', 0);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.map((c) => c.chunkText).join('')).toBe('car wash near me');
    });

    it('the final chunk has no trailing space', () => {
      const manager = new SfxManager(makeSfxConfig(tmpDir), logger);
      const chunks = manager.buildTypingTimelineWithKeystrokes('one two three four', 0);
      expect(chunks[chunks.length - 1].chunkText.endsWith(' ')).toBe(false);
      for (const chunk of chunks.slice(0, -1)) {
        expect(chunk.chunkText.endsWith(' ')).toBe(true);
      }
    });
  });

  describe('degenerate clip filtering', () => {
    it('prefers a real clip over a tiny slicing artifact despite char-count score', () => {
      // 66ms single-keystroke artifact whose typedText ("k") is char-closest to "me"
      generateTestTone(path.join(tmpDir, 'typing', 'tiny.wav'), { durationSec: 0.066 });
      writeClipJson(path.join(tmpDir, 'typing'), 'tiny', {
        audioFile: 'tiny.wav',
        durationMs: 66,
        typedText: 'k',
        wordCount: 1,
        backspaceSequences: 0,
        maxConsecutiveBackspaces: 0,
        keystrokes: [
          { key: 'k', timestampMs: 0 },
          { key: 'space', timestampMs: 66 },
        ],
      });
      generateTestTone(path.join(tmpDir, 'typing', 'real.wav'), { durationSec: 1.2 });
      writeClipJson(path.join(tmpDir, 'typing'), 'real', {
        audioFile: 'real.wav',
        durationMs: 1200,
        typedText: 'summer',
        wordCount: 1,
        backspaceSequences: 0,
        maxConsecutiveBackspaces: 0,
        keystrokes: [
          { key: 's', timestampMs: 0 },
          { key: 'u', timestampMs: 200 },
          { key: 'm', timestampMs: 400 },
          { key: 'm', timestampMs: 600 },
          { key: 'e', timestampMs: 800 },
          { key: 'r', timestampMs: 1000 },
        ],
      });

      const manager = new SfxManager(makeSfxConfig(tmpDir), logger);
      const result = manager.getTypingSfx('me', 0);
      expect(result).not.toBeNull();
      expect(path.basename(result!.event.audioFile)).toBe('real.wav');
    });

    it('still uses a degenerate clip when nothing else exists', () => {
      generateTestTone(path.join(tmpDir, 'typing', 'tiny.wav'), { durationSec: 0.066 });
      writeClipJson(path.join(tmpDir, 'typing'), 'tiny', {
        audioFile: 'tiny.wav',
        durationMs: 66,
        typedText: 'k',
        wordCount: 1,
        backspaceSequences: 0,
        maxConsecutiveBackspaces: 0,
        keystrokes: [{ key: 'k', timestampMs: 0 }],
      });

      const manager = new SfxManager(makeSfxConfig(tmpDir), logger);
      const result = manager.getTypingSfx('me', 0);
      expect(result).not.toBeNull();
      expect(path.basename(result!.event.audioFile)).toBe('tiny.wav');
    });
  });
});
