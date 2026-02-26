import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseTranscript } from '../../src/utils/transcript-parser';

const FIXTURES = path.join(__dirname, '..', 'fixtures');

describe('Transcript Parser', () => {
  describe('SRT parsing', () => {
    it('parses a valid SRT file into segments', () => {
      const segments = parseTranscript(path.join(FIXTURES, 'sample.srt'));
      expect(segments).toHaveLength(3);
    });

    it('extracts correct timestamps from SRT', () => {
      const segments = parseTranscript(path.join(FIXTURES, 'sample.srt'));
      expect(segments[0].startTime).toBe(0);
      expect(segments[0].endTime).toBe(5);
      expect(segments[1].startTime).toBe(5);
      expect(segments[1].endTime).toBe(10);
      expect(segments[2].startTime).toBe(10);
      expect(segments[2].endTime).toBe(15);
    });

    it('extracts text content from SRT', () => {
      const segments = parseTranscript(path.join(FIXTURES, 'sample.srt'));
      expect(segments[0].text).toContain('Artificial intelligence');
      expect(segments[1].text).toContain('Machine learning');
      expect(segments[2].text).toContain('Neural networks');
    });

    it('handles SRT timestamps with millisecond precision', () => {
      const segments = parseTranscript(path.join(FIXTURES, 'sample.srt'));
      // 00:00:00,000 = exactly 0
      expect(segments[0].startTime).toBeCloseTo(0, 2);
    });
  });

  describe('VTT parsing', () => {
    it('parses a valid VTT file into segments', () => {
      const segments = parseTranscript(path.join(FIXTURES, 'sample.vtt'));
      expect(segments).toHaveLength(2);
    });

    it('strips the WEBVTT header', () => {
      const segments = parseTranscript(path.join(FIXTURES, 'sample.vtt'));
      expect(segments[0].text).not.toContain('WEBVTT');
    });

    it('extracts correct timestamps from VTT', () => {
      const segments = parseTranscript(path.join(FIXTURES, 'sample.vtt'));
      expect(segments[0].startTime).toBe(0);
      expect(segments[0].endTime).toBe(5);
    });
  });

  describe('Plain timestamped text parsing', () => {
    it('parses [MM:SS] format', () => {
      const segments = parseTranscript(path.join(FIXTURES, 'sample-timestamps.txt'));
      expect(segments).toHaveLength(3);
    });

    it('extracts correct timestamps from plain text', () => {
      const segments = parseTranscript(path.join(FIXTURES, 'sample-timestamps.txt'));
      expect(segments[0].startTime).toBe(0);
      expect(segments[1].startTime).toBe(5);
      expect(segments[2].startTime).toBe(10);
    });

    it('infers end times from subsequent segments', () => {
      const segments = parseTranscript(path.join(FIXTURES, 'sample-timestamps.txt'));
      // End of segment 0 should be start of segment 1
      expect(segments[0].endTime).toBe(5);
      expect(segments[1].endTime).toBe(10);
    });
  });
});
