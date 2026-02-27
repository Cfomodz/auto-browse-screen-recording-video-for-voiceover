/**
 * Unit tests for click/scroll SFX types and SfxManager behaviour.
 *
 * Tests the new typed-click loading, clickSignalMs offset logic,
 * scroll clip matching, and the multi-clip typing chain now used by
 * the TypingAnimator.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SfxManager } from '../../src/sfx/manager';
import {
  SfxConfig,
  ClickClipMeta,
  ScrollClipMeta,
  TypingClipMeta,
} from '../../src/core/types';
import { createLogger } from '../../src/utils/logger';
import { makeTempDir, generateTestTone } from '../helpers';

const logger = createLogger('test');
logger.silent = true;

function makeConfig(libraryPath: string, overrides?: Partial<SfxConfig>): SfxConfig {
  return {
    enabled: true,
    libraryPath,
    volume: 0.4,
    mouseClick: { enabled: true, samplesDir: 'clicks' },
    keyboardTyping: { enabled: true, samplesDir: 'typing' },
    ...overrides,
  };
}

// ─── Click SFX (typed subdirs) ───────────────────────────────────────────────

describe('SfxManager – typed click clips', () => {
  let tmpDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const tmp = makeTempDir('click-sfx-test-');
    tmpDir = tmp.dir;
    cleanup = tmp.cleanup;
    ['left', 'right', 'double'].forEach((t) =>
      fs.mkdirSync(path.join(tmpDir, 'clicks', t), { recursive: true })
    );
  });

  afterEach(() => cleanup());

  function writeClickClip(subdir: string, name: string, meta: ClickClipMeta) {
    const dir = path.join(tmpDir, 'clicks', subdir);
    generateTestTone(path.join(dir, `${name}.wav`), { durationSec: 0.4 });
    fs.writeFileSync(
      path.join(dir, `${name}.json`),
      JSON.stringify({ ...meta, audioFile: `${name}.wav` })
    );
  }

  it('loads left/right/double click clips from typed subdirs', () => {
    writeClickClip('left', 'lc_001', { audioFile: '', durationMs: 400, clickType: 'left', clickSignalMs: 80 });
    writeClickClip('right', 'rc_001', { audioFile: '', durationMs: 400, clickType: 'right', clickSignalMs: 80 });
    writeClickClip('double', 'dc_001', { audioFile: '', durationMs: 400, clickType: 'double', clickSignalMs: 80 });

    const mgr = new SfxManager(makeConfig(tmpDir), logger);
    expect(mgr.getClickSfx(1.0, 'left')).not.toBeNull();
    expect(mgr.getClickSfx(1.0, 'right')).not.toBeNull();
    expect(mgr.getClickSfx(1.0, 'double')).not.toBeNull();
  });

  it('adjusts timeOffset backward by clickSignalMs', () => {
    writeClickClip('left', 'lc_001', { audioFile: '', durationMs: 430, clickType: 'left', clickSignalMs: 80 });
    const mgr = new SfxManager(makeConfig(tmpDir), logger);
    const sfx = mgr.getClickSfx(2.0, 'left');
    expect(sfx).not.toBeNull();
    // Audio should start 80ms before the click so the transient lands at 2.0s
    expect(sfx!.timeOffset).toBeCloseTo(2.0 - 0.08, 5);
    expect(sfx!.durationSeconds).toBeCloseTo(0.43, 2);
  });

  it('falls back to legacy flat WAV pool when typed subdirs are empty', () => {
    // No typed subdirs – use old-style flat clicks dir
    const tmpFlat = makeTempDir('click-flat-').dir;
    fs.mkdirSync(path.join(tmpFlat, 'clicks'), { recursive: true });
    generateTestTone(path.join(tmpFlat, 'clicks', 'click1.wav'), { durationSec: 0.3 });

    const mgr = new SfxManager(makeConfig(tmpFlat), logger);
    const sfx = mgr.getClickSfx(0.5);
    expect(sfx).not.toBeNull();
    expect(sfx!.timeOffset).toBe(0.5); // no adjustment for legacy clips
    fs.rmSync(tmpFlat, { recursive: true, force: true });
  });

  it('returns null when mouseClick is disabled', () => {
    writeClickClip('left', 'lc_001', { audioFile: '', durationMs: 400, clickType: 'left', clickSignalMs: 80 });
    const mgr = new SfxManager(
      makeConfig(tmpDir, { mouseClick: { enabled: false, samplesDir: 'clicks' } }),
      logger
    );
    expect(mgr.getClickSfx(0, 'left')).toBeNull();
  });

  it('returns null for a type with no clips even when other types have clips', () => {
    writeClickClip('left', 'lc_001', { audioFile: '', durationMs: 400, clickType: 'left', clickSignalMs: 80 });
    const mgr = new SfxManager(makeConfig(tmpDir), logger);
    // right and double pools are empty; fallback to legacy pool which is also empty
    expect(mgr.getClickSfx(0, 'right')).toBeNull();
    expect(mgr.getClickSfx(0, 'double')).toBeNull();
  });
});

// ─── Scroll SFX ──────────────────────────────────────────────────────────────

describe('SfxManager – scroll clips', () => {
  let tmpDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const tmp = makeTempDir('scroll-sfx-test-');
    tmpDir = tmp.dir;
    cleanup = tmp.cleanup;
    fs.mkdirSync(path.join(tmpDir, 'scrolls'), { recursive: true });
  });

  afterEach(() => cleanup());

  function writeScrollClip(name: string, meta: Omit<ScrollClipMeta, 'audioFile'>) {
    generateTestTone(path.join(tmpDir, 'scrolls', `${name}.wav`), { durationSec: meta.durationMs / 1000 });
    fs.writeFileSync(
      path.join(tmpDir, 'scrolls', `${name}.json`),
      JSON.stringify({ ...meta, audioFile: `${name}.wav` })
    );
  }

  it('loads scroll clips and returns the closest match by totalDeltaY', () => {
    writeScrollClip('sc_200', { durationMs: 800, totalDeltaY: 200, direction: 'down', events: [{ deltaY: 200, timestampMs: 0 }] });
    writeScrollClip('sc_500', { durationMs: 1200, totalDeltaY: 500, direction: 'down', events: [{ deltaY: 500, timestampMs: 0 }] });

    const mgr = new SfxManager(
      makeConfig(tmpDir, { mouseScroll: { enabled: true, samplesDir: 'scrolls' } }),
      logger
    );
    const result = mgr.getScrollSfx(450, 'down', 3.0);
    expect(result).not.toBeNull();
    // 450 is closer to 500 than 200
    expect(result!.clip.totalDeltaY).toBe(500);
    expect(result!.event.timeOffset).toBe(3.0);
    expect(result!.event.type).toBe('scroll');
  });

  it('prefers direction match over distance match', () => {
    writeScrollClip('sc_down', { durationMs: 800, totalDeltaY: 300, direction: 'down', events: [{ deltaY: 300, timestampMs: 0 }] });
    writeScrollClip('sc_up', { durationMs: 800, totalDeltaY: 300, direction: 'up', events: [{ deltaY: -300, timestampMs: 0 }] });

    const mgr = new SfxManager(
      makeConfig(tmpDir, { mouseScroll: { enabled: true, samplesDir: 'scrolls' } }),
      logger
    );
    const result = mgr.getScrollSfx(300, 'up', 0);
    expect(result).not.toBeNull();
    expect(result!.clip.direction).toBe('up');
  });

  it('returns null when mouseScroll is disabled', () => {
    writeScrollClip('sc_001', { durationMs: 800, totalDeltaY: 300, direction: 'down', events: [] });
    const mgr = new SfxManager(makeConfig(tmpDir), logger); // no mouseScroll config
    expect(mgr.getScrollSfx(300, 'down', 0)).toBeNull();
  });

  it('returns null when scroll library is empty', () => {
    const mgr = new SfxManager(
      makeConfig(tmpDir, { mouseScroll: { enabled: true, samplesDir: 'scrolls' } }),
      logger
    );
    expect(mgr.getScrollSfx(300, 'down', 0)).toBeNull();
  });
});

// ─── buildTypingTimelineWithKeystrokes ────────────────────────────────────────

describe('SfxManager – buildTypingTimelineWithKeystrokes', () => {
  let tmpDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const tmp = makeTempDir('typing-chain-test-');
    tmpDir = tmp.dir;
    cleanup = tmp.cleanup;
    fs.mkdirSync(path.join(tmpDir, 'typing'), { recursive: true });
  });

  afterEach(() => cleanup());

  function writeTypingClip(name: string, meta: TypingClipMeta) {
    generateTestTone(path.join(tmpDir, 'typing', `${name}.wav`), { durationSec: meta.durationMs / 1000 });
    fs.writeFileSync(path.join(tmpDir, 'typing', `${name}.json`), JSON.stringify({ ...meta, audioFile: `${name}.wav` }));
  }

  it('returns one chunk per word-count-matched clip', () => {
    writeTypingClip('t_001', {
      audioFile: '', durationMs: 600, typedText: 'hello', wordCount: 1,
      backspaceSequences: 0, maxConsecutiveBackspaces: 0,
      keystrokes: [{ key: 'h', timestampMs: 0 }, { key: 'e', timestampMs: 80 }],
    });
    writeTypingClip('t_002', {
      audioFile: '', durationMs: 800, typedText: 'world test', wordCount: 2,
      backspaceSequences: 0, maxConsecutiveBackspaces: 0,
      keystrokes: [{ key: 'w', timestampMs: 0 }, { key: 'o', timestampMs: 80 }, { key: 'r', timestampMs: 160 }],
    });

    const mgr = new SfxManager(makeConfig(tmpDir), logger);
    const chunks = mgr.buildTypingTimelineWithKeystrokes('hello world test', 0);
    // Scoring evaluates full remaining text each time.
    // For 'hello world test' (3 words), the 2-word clip scores closer than the
    // 1-word clip → chunk0 = 'hello world'.  Remaining 'test' (1 word) matches
    // the 1-word clip → chunk1 = 'test'.
    expect(chunks.length).toBe(2);
    expect(chunks[0].chunkText).toBe('hello world');
    expect(chunks[1].chunkText).toBe('test');
    // Events should be sequential in time
    expect(chunks[1].event.timeOffset).toBeGreaterThan(chunks[0].event.timeOffset);
  });

  it('each chunk carries the clip keystrokes', () => {
    writeTypingClip('t_001', {
      audioFile: '', durationMs: 600, typedText: 'hi', wordCount: 1,
      backspaceSequences: 0, maxConsecutiveBackspaces: 0,
      keystrokes: [{ key: 'h', timestampMs: 0 }, { key: 'i', timestampMs: 90 }],
    });
    const mgr = new SfxManager(makeConfig(tmpDir), logger);
    const chunks = mgr.buildTypingTimelineWithKeystrokes('hi', 0);
    expect(chunks[0].keystrokes).toHaveLength(2);
    expect(chunks[0].keystrokes[0].key).toBe('h');
  });

  it('startTimeOffset shifts all event offsets', () => {
    writeTypingClip('t_001', {
      audioFile: '', durationMs: 500, typedText: 'go', wordCount: 1,
      backspaceSequences: 0, maxConsecutiveBackspaces: 0, keystrokes: [],
    });
    const mgr = new SfxManager(makeConfig(tmpDir), logger);
    const chunks = mgr.buildTypingTimelineWithKeystrokes('go', 5.0);
    expect(chunks[0].event.timeOffset).toBe(5.0);
  });

  it('returns empty array when typing is disabled', () => {
    const mgr = new SfxManager(
      makeConfig(tmpDir, { keyboardTyping: { enabled: false, samplesDir: 'typing' } }),
      logger
    );
    expect(mgr.buildTypingTimelineWithKeystrokes('hello', 0)).toHaveLength(0);
  });

  it('buildTypingTimeline is a backwards-compatible wrapper', () => {
    writeTypingClip('t_001', {
      audioFile: '', durationMs: 500, typedText: 'test', wordCount: 1,
      backspaceSequences: 0, maxConsecutiveBackspaces: 0, keystrokes: [],
    });
    const mgr = new SfxManager(makeConfig(tmpDir), logger);
    const events = mgr.buildTypingTimeline('test', 0);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe('typing');
  });
});
