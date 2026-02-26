import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CoverageAnalyzer } from '../../src/keystroke-recorder/coverage';
import { TypingClipMeta } from '../../src/core/types';
import { createLogger } from '../../src/utils/logger';
import { makeTempDir } from '../helpers';

const logger = createLogger('test');
logger.silent = true;

function makeClipMeta(overrides?: Partial<TypingClipMeta>): TypingClipMeta {
  return {
    audioFile: 'clip.wav',
    durationMs: 2000,
    typedText: 'hello world',
    wordCount: 2,
    backspaceSequences: 0,
    maxConsecutiveBackspaces: 0,
    keystrokes: [],
    ...overrides,
  };
}

describe('CoverageAnalyzer', () => {
  let tmpDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    const tmp = makeTempDir('coverage-test-');
    tmpDir = tmp.dir;
    cleanup = tmp.cleanup;
  });

  afterEach(() => cleanup());

  describe('pattern definitions', () => {
    it('defines exactly 60 patterns (5 x 4 x 3)', () => {
      const analyzer = new CoverageAnalyzer(tmpDir, logger);
      const report = analyzer.analyze();
      expect(report.totalPatterns).toBe(60);
    });

    it('reports 0 coverage on empty library', () => {
      const analyzer = new CoverageAnalyzer(tmpDir, logger);
      const report = analyzer.analyze();
      expect(report.coveredPatterns).toBe(0);
      expect(report.coveragePercent).toBe(0);
      expect(report.totalClips).toBe(0);
      expect(report.uncovered).toHaveLength(60);
    });
  });

  describe('classifyClip', () => {
    it('classifies a 2-word medium-length clean clip', () => {
      const analyzer = new CoverageAnalyzer(tmpDir, logger);
      const clip = makeClipMeta({
        typedText: 'hello world',
        wordCount: 2,
        backspaceSequences: 0,
      });
      const pattern = analyzer.classifyClip(clip);
      expect(pattern.wordCountBucket).toBe('2');
      expect(pattern.wordLengthBucket).toBe('medium');
      expect(pattern.backspaceBucket).toBe('0');
      expect(pattern.key).toBe('wc2_wl-medium_bs0');
    });

    it('classifies a single short word', () => {
      const analyzer = new CoverageAnalyzer(tmpDir, logger);
      const clip = makeClipMeta({
        typedText: 'ai',
        wordCount: 1,
        backspaceSequences: 0,
      });
      const pattern = analyzer.classifyClip(clip);
      expect(pattern.wordCountBucket).toBe('1');
      expect(pattern.wordLengthBucket).toBe('short');
      expect(pattern.backspaceBucket).toBe('0');
    });

    it('classifies 6+ words as the 6+ bucket', () => {
      const analyzer = new CoverageAnalyzer(tmpDir, logger);
      const clip = makeClipMeta({
        typedText: 'one two three four five six seven',
        wordCount: 7,
        backspaceSequences: 0,
      });
      const pattern = analyzer.classifyClip(clip);
      expect(pattern.wordCountBucket).toBe('6+');
    });

    it('classifies long words correctly', () => {
      const analyzer = new CoverageAnalyzer(tmpDir, logger);
      const clip = makeClipMeta({
        typedText: 'extraordinarily unconventional',
        wordCount: 2,
        backspaceSequences: 0,
      });
      const pattern = analyzer.classifyClip(clip);
      expect(pattern.wordLengthBucket).toBe('long');
    });

    it('classifies mixed word lengths correctly', () => {
      const analyzer = new CoverageAnalyzer(tmpDir, logger);
      const clip = makeClipMeta({
        typedText: 'AI transformer',
        wordCount: 2,
        backspaceSequences: 0,
      });
      const pattern = analyzer.classifyClip(clip);
      // 'AI' is 2 chars, 'transformer' is 11 chars, diff is 9 > 4 → mixed
      expect(pattern.wordLengthBucket).toBe('mixed');
    });

    it('classifies backspaces into 1-2 bucket', () => {
      const analyzer = new CoverageAnalyzer(tmpDir, logger);
      const clip = makeClipMeta({
        typedText: 'test',
        wordCount: 1,
        backspaceSequences: 2,
      });
      const pattern = analyzer.classifyClip(clip);
      expect(pattern.backspaceBucket).toBe('1-2');
    });

    it('classifies 3+ backspaces correctly', () => {
      const analyzer = new CoverageAnalyzer(tmpDir, logger);
      const clip = makeClipMeta({
        typedText: 'test',
        wordCount: 1,
        backspaceSequences: 5,
      });
      const pattern = analyzer.classifyClip(clip);
      expect(pattern.backspaceBucket).toBe('3+');
    });

    it('classifies 4-5 word count bucket', () => {
      const analyzer = new CoverageAnalyzer(tmpDir, logger);
      const clip = makeClipMeta({
        typedText: 'one two three four',
        wordCount: 4,
        backspaceSequences: 0,
      });
      const pattern = analyzer.classifyClip(clip);
      expect(pattern.wordCountBucket).toBe('4-5');
    });
  });

  describe('analyze with clips', () => {
    it('reports coverage when clips exist', () => {
      // Write a clip JSON into the temp dir
      const clip = makeClipMeta({ typedText: 'hello world', wordCount: 2, backspaceSequences: 0 });
      fs.writeFileSync(path.join(tmpDir, 'clip_001.json'), JSON.stringify(clip));

      const analyzer = new CoverageAnalyzer(tmpDir, logger);
      const report = analyzer.analyze();
      expect(report.totalClips).toBe(1);
      expect(report.coveredPatterns).toBe(1);
      expect(report.coveragePercent).toBeCloseTo(1 / 60 * 100, 1);
    });

    it('counts multiple clips for the same pattern', () => {
      const clip1 = makeClipMeta({ typedText: 'hello world', wordCount: 2, backspaceSequences: 0 });
      const clip2 = makeClipMeta({ typedText: 'search query', wordCount: 2, backspaceSequences: 0 });
      fs.writeFileSync(path.join(tmpDir, 'clip_001.json'), JSON.stringify(clip1));
      fs.writeFileSync(path.join(tmpDir, 'clip_002.json'), JSON.stringify(clip2));

      const analyzer = new CoverageAnalyzer(tmpDir, logger);
      const report = analyzer.analyze();
      expect(report.totalClips).toBe(2);
      // Both are same pattern (wc2_wl-medium_bs0) so only 1 covered
      expect(report.coveredPatterns).toBe(1);
      const covered = report.covered.find((c) => c.pattern.key === 'wc2_wl-medium_bs0');
      expect(covered?.clipCount).toBe(2);
    });

    it('detects script-specific gaps', () => {
      const analyzer = new CoverageAnalyzer(tmpDir, logger);
      const report = analyzer.analyze('Neural network architecture for deep learning');
      expect(report.scriptGaps.length).toBeGreaterThan(0);
      // Script gaps should be a subset of uncovered
      for (const gap of report.scriptGaps) {
        expect(report.uncovered.some((u) => u.key === gap.key)).toBe(true);
      }
    });
  });

  describe('generatePrompts', () => {
    it('generates one prompt per gap pattern', () => {
      const analyzer = new CoverageAnalyzer(tmpDir, logger);
      const report = analyzer.analyze();
      const prompts = analyzer.generatePrompts(report.uncovered.slice(0, 5));
      expect(prompts).toHaveLength(5);
      for (const p of prompts) {
        expect(p.prompt.length).toBeGreaterThan(0);
        expect(p.pattern.key.length).toBeGreaterThan(0);
      }
    });

    it('includes correction instructions for non-zero backspace patterns', () => {
      const analyzer = new CoverageAnalyzer(tmpDir, logger);
      const report = analyzer.analyze();
      const bsPatterns = report.uncovered.filter((p) => p.backspaceBucket !== '0');
      if (bsPatterns.length > 0) {
        const prompts = analyzer.generatePrompts(bsPatterns.slice(0, 3));
        for (const p of prompts) {
          expect(p.prompt).toContain('mistake');
        }
      }
    });

    it('includes "cleanly" instruction for zero-backspace patterns', () => {
      const analyzer = new CoverageAnalyzer(tmpDir, logger);
      const report = analyzer.analyze();
      const cleanPatterns = report.uncovered.filter((p) => p.backspaceBucket === '0');
      if (cleanPatterns.length > 0) {
        const prompts = analyzer.generatePrompts(cleanPatterns.slice(0, 3));
        for (const p of prompts) {
          expect(p.prompt).toContain('cleanly');
        }
      }
    });
  });
});
