import * as fs from 'fs';
import * as path from 'path';
import { TranscriptSegment } from '../core/types';

/**
 * Parses transcript files in SRT, VTT, or simple timestamped text format.
 */
export function parseTranscript(filePath: string): TranscriptSegment[] {
  const ext = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath, 'utf-8');

  switch (ext) {
    case '.srt':
      return parseSRT(content);
    case '.vtt':
      return parseVTT(content);
    default:
      return parsePlainTimestamped(content);
  }
}

function parseSRT(content: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  // Split on double newlines (SRT blocks)
  const blocks = content.trim().split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;

    // Line 1: sequence number (skip)
    // Line 2: timestamp range
    const timeMatch = lines[1].match(
      /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/
    );
    if (!timeMatch) continue;

    const startTime = srtTimeToSeconds(timeMatch.slice(1, 5));
    const endTime = srtTimeToSeconds(timeMatch.slice(5, 9));
    const text = lines.slice(2).join(' ').trim();

    segments.push({ startTime, endTime, text });
  }

  return segments;
}

function parseVTT(content: string): TranscriptSegment[] {
  // VTT is similar to SRT but starts with "WEBVTT" header
  const withoutHeader = content.replace(/^WEBVTT[^\n]*\n\n?/, '');
  return parseSRT(withoutHeader);
}

function parsePlainTimestamped(content: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  // Expected format: [MM:SS] or [HH:MM:SS] text
  const lines = content.trim().split('\n');

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(
      /\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]\s*(.*)/
    );
    if (!match) continue;

    const hours = match[1] ? parseInt(match[1], 10) : 0;
    const minutes = parseInt(match[2], 10);
    const seconds = parseInt(match[3], 10);
    const startTime = hours * 3600 + minutes * 60 + seconds;
    const text = match[4].trim();

    // End time is either the start of the next segment or start + 5s
    let endTime = startTime + 5;
    if (i + 1 < lines.length) {
      const nextMatch = lines[i + 1].match(
        /\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\]/
      );
      if (nextMatch) {
        const nh = nextMatch[1] ? parseInt(nextMatch[1], 10) : 0;
        const nm = parseInt(nextMatch[2], 10);
        const ns = parseInt(nextMatch[3], 10);
        endTime = nh * 3600 + nm * 60 + ns;
      }
    }

    segments.push({ startTime, endTime, text });
  }

  return segments;
}

function srtTimeToSeconds(parts: string[]): number {
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const s = parseInt(parts[2], 10);
  const ms = parseInt(parts[3], 10);
  return h * 3600 + m * 60 + s + ms / 1000;
}
