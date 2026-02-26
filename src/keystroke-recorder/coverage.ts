import * as fs from 'fs';
import * as path from 'path';
import { TypingClipMeta } from '../core/types';
import { Logger } from '../utils/logger';

/**
 * A typing pattern is a normalized description of a keystroke sequence.
 * The library needs clips that cover a variety of these patterns so
 * that any typed text in the pipeline can be matched to audio.
 *
 * Patterns are characterized by:
 *   - Word length bucket (short 1-3 chars, medium 4-7, long 8+)
 *   - Word count bucket (1, 2, 3, 4-5, 6+)
 *   - Whether the sequence includes backspace corrections (0, 1-2, 3+)
 *   - Inter-word pause style (none/fast/thinking)
 */
export interface TypingPattern {
  /** Bucket key like "wc2_wl-medium_bs0" */
  key: string;
  /** Human-readable description. */
  description: string;
  /** Word count bucket. */
  wordCountBucket: '1' | '2' | '3' | '4-5' | '6+';
  /** Dominant word length bucket. */
  wordLengthBucket: 'short' | 'medium' | 'long' | 'mixed';
  /** Backspace correction bucket. */
  backspaceBucket: '0' | '1-2' | '3+';
}

/**
 * Coverage report for the typing SFX library.
 */
export interface CoverageReport {
  /** Total number of distinct patterns defined. */
  totalPatterns: number;
  /** Number of patterns that have at least one clip. */
  coveredPatterns: number;
  /** Coverage percentage (0–100). */
  coveragePercent: number;
  /** Patterns that have clips. */
  covered: Array<{ pattern: TypingPattern; clipCount: number }>;
  /** Patterns with no clips at all. */
  uncovered: TypingPattern[];
  /** Patterns needed by the given script but missing from library. */
  scriptGaps: TypingPattern[];
  /** Total clips in the library. */
  totalClips: number;
}

/**
 * Coverage analyzer for the keystroke audio library.
 *
 * Defines the universe of typing patterns, checks which ones the
 * library already has clips for, and identifies gaps — optionally
 * against a specific script that will be used in the pipeline.
 *
 * Coverage target: 90% of all defined patterns have at least one clip.
 */
export class CoverageAnalyzer {
  private logger: Logger;
  private libraryDir: string;
  private clips: TypingClipMeta[] = [];

  /** All defined patterns (the full universe). */
  private allPatterns: TypingPattern[];

  constructor(libraryDir: string, logger: Logger) {
    this.logger = logger;
    this.libraryDir = libraryDir;
    this.allPatterns = this.definePatterns();
    this.loadClips();
  }

  /** Load existing clips from the library directory. */
  private loadClips(): void {
    if (!fs.existsSync(this.libraryDir)) {
      this.logger.info(`Library directory does not exist yet: ${this.libraryDir}`);
      return;
    }

    const jsonFiles = fs.readdirSync(this.libraryDir).filter((f) => f.endsWith('.json'));
    for (const file of jsonFiles) {
      try {
        const meta: TypingClipMeta = JSON.parse(
          fs.readFileSync(path.join(this.libraryDir, file), 'utf-8')
        );
        this.clips.push(meta);
      } catch {
        // Skip malformed files
      }
    }

    this.logger.info(`Loaded ${this.clips.length} existing clips from library.`);
  }

  /**
   * Define all typing patterns.
   *
   * Combinatorial: wordCount x wordLength x backspaces.
   * This produces 60 patterns (5 x 4 x 3), which is a reasonable
   * granularity — 90% coverage means ~54 of 60.
   */
  private definePatterns(): TypingPattern[] {
    const wordCounts: Array<TypingPattern['wordCountBucket']> = ['1', '2', '3', '4-5', '6+'];
    const wordLengths: Array<TypingPattern['wordLengthBucket']> = ['short', 'medium', 'long', 'mixed'];
    const backspaces: Array<TypingPattern['backspaceBucket']> = ['0', '1-2', '3+'];

    const patterns: TypingPattern[] = [];

    for (const wc of wordCounts) {
      for (const wl of wordLengths) {
        for (const bs of backspaces) {
          const key = `wc${wc}_wl-${wl}_bs${bs}`;
          const description = [
            `${wc} word${wc === '1' ? '' : 's'}`,
            `${wl} length`,
            bs === '0' ? 'clean' : `${bs} correction${bs === '1-2' ? '(s)' : 's'}`,
          ].join(', ');

          patterns.push({
            key,
            description,
            wordCountBucket: wc,
            wordLengthBucket: wl,
            backspaceBucket: bs,
          });
        }
      }
    }

    return patterns;
  }

  /** Classify a clip into its pattern. */
  classifyClip(clip: TypingClipMeta): TypingPattern {
    const wordCountBucket = this.bucketWordCount(clip.wordCount);
    const wordLengthBucket = this.bucketWordLength(clip.typedText);
    const backspaceBucket = this.bucketBackspaces(clip.backspaceSequences);

    const key = `wc${wordCountBucket}_wl-${wordLengthBucket}_bs${backspaceBucket}`;
    return {
      key,
      description: '',
      wordCountBucket,
      wordLengthBucket,
      backspaceBucket,
    };
  }

  private bucketWordCount(wc: number): TypingPattern['wordCountBucket'] {
    if (wc <= 1) return '1';
    if (wc === 2) return '2';
    if (wc === 3) return '3';
    if (wc <= 5) return '4-5';
    return '6+';
  }

  private bucketWordLength(text: string): TypingPattern['wordLengthBucket'] {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return 'short';

    const lengths = words.map((w) => w.length);
    const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;

    // Check if mixed (high variance)
    if (words.length > 1) {
      const min = Math.min(...lengths);
      const max = Math.max(...lengths);
      if (max - min > 4) return 'mixed';
    }

    if (avg <= 3) return 'short';
    if (avg <= 7) return 'medium';
    return 'long';
  }

  private bucketBackspaces(bs: number): TypingPattern['backspaceBucket'] {
    if (bs === 0) return '0';
    if (bs <= 2) return '1-2';
    return '3+';
  }

  /**
   * Generate a full coverage report.
   *
   * @param scriptText Optional: text from a script to check which
   *                   patterns would be needed but are missing.
   */
  analyze(scriptText?: string): CoverageReport {
    // Map each clip to its pattern
    const patternClipCounts = new Map<string, number>();
    for (const clip of this.clips) {
      const pattern = this.classifyClip(clip);
      patternClipCounts.set(pattern.key, (patternClipCounts.get(pattern.key) ?? 0) + 1);
    }

    const covered: Array<{ pattern: TypingPattern; clipCount: number }> = [];
    const uncovered: TypingPattern[] = [];

    for (const pattern of this.allPatterns) {
      const count = patternClipCounts.get(pattern.key) ?? 0;
      if (count > 0) {
        covered.push({ pattern, clipCount: count });
      } else {
        uncovered.push(pattern);
      }
    }

    // Script-specific gap analysis
    let scriptGaps: TypingPattern[] = [];
    if (scriptText) {
      scriptGaps = this.findScriptGaps(scriptText, patternClipCounts);
    }

    const coveragePercent = this.allPatterns.length > 0
      ? (covered.length / this.allPatterns.length) * 100
      : 0;

    return {
      totalPatterns: this.allPatterns.length,
      coveredPatterns: covered.length,
      coveragePercent,
      covered,
      uncovered,
      scriptGaps,
      totalClips: this.clips.length,
    };
  }

  /**
   * Given a script, break it into the search queries / typed texts
   * it would produce, classify each, and find which patterns are
   * needed but not covered.
   */
  private findScriptGaps(
    scriptText: string,
    existingPatterns: Map<string, number>
  ): TypingPattern[] {
    // Simulate what the pipeline would type: break script into
    // phrase-length chunks (mimicking search queries from topics)
    const phrases = this.extractPhrases(scriptText);
    const neededKeys = new Set<string>();

    for (const phrase of phrases) {
      const wordCount = phrase.split(/\s+/).filter(Boolean).length;
      const wcBucket = this.bucketWordCount(wordCount);
      const wlBucket = this.bucketWordLength(phrase);

      // We need clean versions and versions with corrections
      for (const bs of ['0', '1-2'] as const) {
        neededKeys.add(`wc${wcBucket}_wl-${wlBucket}_bs${bs}`);
      }
    }

    // Find needed patterns that have zero clips
    const gaps: TypingPattern[] = [];
    for (const key of neededKeys) {
      if ((existingPatterns.get(key) ?? 0) === 0) {
        const pattern = this.allPatterns.find((p) => p.key === key);
        if (pattern) gaps.push(pattern);
      }
    }

    return gaps;
  }

  /**
   * Extract search-query-like phrases from transcript text.
   * Mimics how the pipeline would break topics into typed searches.
   */
  private extractPhrases(text: string): string[] {
    const phrases: string[] = [];

    // Split into sentences
    const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);

    for (const sentence of sentences) {
      const words = sentence.split(/\s+/);

      // Extract noun-phrase-like chunks of 1-4 words
      // (heuristic: skip common function words at boundaries)
      const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by']);

      for (let len = 1; len <= Math.min(4, words.length); len++) {
        for (let start = 0; start <= words.length - len; start++) {
          const chunk = words.slice(start, start + len);
          // Skip if it starts or ends with a stop word
          if (stopWords.has(chunk[0].toLowerCase())) continue;
          if (stopWords.has(chunk[chunk.length - 1].toLowerCase())) continue;
          phrases.push(chunk.join(' '));
        }
      }
    }

    // Deduplicate
    return [...new Set(phrases)];
  }

  /**
   * Generate guided recording prompts for uncovered patterns.
   * Returns example texts the user should type to fill each gap.
   */
  generatePrompts(gaps: TypingPattern[]): Array<{ pattern: TypingPattern; prompt: string }> {
    return gaps.map((pattern) => {
      const prompt = this.generateExampleText(pattern);
      return { pattern, prompt };
    });
  }

  private generateExampleText(pattern: TypingPattern): string {
    const wordCount = this.wordCountFromBucket(pattern.wordCountBucket);
    const wordLength = this.wordLengthFromBucket(pattern.wordLengthBucket);
    const withBackspace = pattern.backspaceBucket !== '0';

    const words = this.pickExampleWords(wordCount, wordLength);
    let text = words.join(' ');

    if (withBackspace) {
      const corrections = pattern.backspaceBucket === '3+' ? 3 : 1;
      text += ` (type with ~${corrections} mistake${corrections > 1 ? 's' : ''} and correct)`;
    } else {
      text += ' (type cleanly, no mistakes)';
    }

    return text;
  }

  private wordCountFromBucket(bucket: TypingPattern['wordCountBucket']): number {
    switch (bucket) {
      case '1': return 1;
      case '2': return 2;
      case '3': return 3;
      case '4-5': return 4;
      case '6+': return 7;
    }
  }

  private wordLengthFromBucket(bucket: TypingPattern['wordLengthBucket']): string {
    switch (bucket) {
      case 'short': return 'short (1-3 chars)';
      case 'medium': return 'medium (4-7 chars)';
      case 'long': return 'long (8+ chars)';
      case 'mixed': return 'mixed lengths';
    }
  }

  private pickExampleWords(count: number, lengthDesc: string): string[] {
    // Example word pools by length bucket
    const shortWords = ['ai', 'ml', 'gpu', 'cpu', 'api', 'web', 'app', 'bot', 'dns', 'sql'];
    const mediumWords = ['search', 'neural', 'model', 'learn', 'train', 'cloud', 'input', 'query', 'layer', 'token'];
    const longWords = ['artificial', 'intelligence', 'transformer', 'architecture', 'processing', 'optimization', 'generation', 'reinforcement', 'convolutional', 'classification'];
    const mixedWords = ['AI transformer model', 'deep learning GPU', 'NLP processing pipeline', 'CNN architecture optimization'];

    let pool: string[];
    if (lengthDesc.includes('short')) pool = shortWords;
    else if (lengthDesc.includes('medium')) pool = mediumWords;
    else if (lengthDesc.includes('long')) pool = longWords;
    else pool = mixedWords;

    // Shuffle and pick
    const shuffled = [...pool].sort(() => Math.random() - 0.5);

    if (lengthDesc.includes('mixed') && count > 1) {
      // For mixed, interleave short and long
      const result: string[] = [];
      for (let i = 0; i < count; i++) {
        if (i % 2 === 0) {
          result.push(longWords[i % longWords.length]);
        } else {
          result.push(shortWords[i % shortWords.length]);
        }
      }
      return result;
    }

    return shuffled.slice(0, count);
  }
}
