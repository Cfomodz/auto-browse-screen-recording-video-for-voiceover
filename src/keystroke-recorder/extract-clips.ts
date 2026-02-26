/**
 * Extract coverage clips from a free-form session after the fact.
 * Segments the keystroke stream by idle gaps, classifies each segment,
 * and slices out clips for patterns we don't yet have.
 */

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { KeystrokeEvent, TypingClipMeta } from '../core/types';
import { Logger } from '../utils/logger';
import { CoverageAnalyzer } from './coverage';
import type { TypingPattern } from './coverage';

const IDLE_MS = 700;

function getMaxExistingClipNumber(dir: string): number {
  let max = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(/^clip_(\d+)\.(json|wav|flac)$/i);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > max) max = n;
      }
    }
  } catch {
    /* ignore */
  }
  return max;
}

/** Build typedText and backspace stats from a keystroke list. */
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

/** Split keystrokes into segments by idle gap (ms). */
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

/** Slice audio with ffmpeg: from startSec for durationSec, normalized to target LUFS (default -14, YouTube-style). */
function sliceWav(
  srcWav: string,
  destWav: string,
  startSec: number,
  durationSec: number,
  logger: Logger,
  targetLUFS: number = -14
): boolean {
  try {
    const result = child_process.spawnSync(
      'ffmpeg',
      [
        '-i', srcWav,
        '-ss', String(startSec),
        '-t', String(durationSec),
        '-af', `loudnorm=I=${targetLUFS}:LRA=11:TP=-1.5`,
        '-y', destWav,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 }
    );
    if (result.status !== 0) {
      logger.warn('ffmpeg slice failed: %s', (result.stderr ?? '').slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    logger.warn('ffmpeg slice error: %s', (e as Error).message);
    return false;
  }
}

/**
 * Extract clips from a session file into the library.
 * Session JSON is TypingClipMeta with one long keystroke list.
 * We segment by idle, match uncovered patterns, and write clip_XXXX.(wav|json).
 * @param options.extractAll - If true, extract every segment (e.g. for re-slice with new normalization).
 * @param options.targetLUFS - Loudness target in LUFS (default -14, YouTube-style; use -12 for louder).
 */
export function extractClipsFromSession(
  sessionJsonPath: string,
  libraryDir: string,
  logger: Logger,
  options?: { scriptText?: string; extractAll?: boolean; targetLUFS?: number }
): number {
  const targetLUFS = options?.targetLUFS ?? -14;
  if (!fs.existsSync(sessionJsonPath)) {
    logger.warn('Session JSON not found: %s', sessionJsonPath);
    return 0;
  }

  const sessionMeta: TypingClipMeta = JSON.parse(
    fs.readFileSync(sessionJsonPath, 'utf-8')
  );
  const sessionDir = path.dirname(sessionJsonPath);
  const sessionWav = path.join(sessionDir, path.basename(sessionMeta.audioFile));
  if (!fs.existsSync(sessionWav)) {
    logger.warn('Session WAV not found: %s', sessionWav);
    return 0;
  }

  const analyzer = new CoverageAnalyzer(libraryDir, logger);
  const report = analyzer.analyze(options?.scriptText);
  const neededKeys = options?.extractAll
    ? null
    : new Set(report.uncovered.map((p) => p.key));
  if (neededKeys !== null && neededKeys.size === 0) {
    logger.info('No coverage gaps; nothing to extract.');
    return 0;
  }

  const segments = segmentByIdle(sessionMeta.keystrokes, IDLE_MS);
  let clipCounter = getMaxExistingClipNumber(libraryDir);
  let extracted = 0;

  for (const seg of segments) {
    if (seg.length === 0) continue;
    const startMs = seg[0].timestampMs;
    const endMs = seg[seg.length - 1].timestampMs;
    const durationMs = endMs - startMs;
    const { typedText, backspaceSequences, maxConsecutiveBackspaces } = replayKeystrokes(seg);
    const wordCount = typedText.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount === 0) continue;

    const segmentMeta: TypingClipMeta = {
      audioFile: '',
      durationMs,
      typedText: typedText.trim(),
      wordCount,
      backspaceSequences,
      maxConsecutiveBackspaces,
      keystrokes: seg.map((k) => ({ key: k.key, timestampMs: k.timestampMs - startMs })),
    };

    const pattern = analyzer.classifyClip(segmentMeta);
    if (neededKeys !== null && !neededKeys.has(pattern.key)) continue;

    clipCounter++;
    const clipName = `clip_${String(clipCounter).padStart(4, '0')}`;
    const ext = path.extname(sessionMeta.audioFile).slice(1) as 'wav' | 'flac';
    const destWav = path.join(libraryDir, `${clipName}.${ext}`);
    const startSec = startMs / 1000;
    const durationSec = durationMs / 1000;

    if (!sliceWav(sessionWav, destWav, startSec, durationSec, logger, targetLUFS)) continue;

    const finalMeta: TypingClipMeta = {
      ...segmentMeta,
      audioFile: `${clipName}.${ext}`,
    };
    fs.writeFileSync(
      path.join(libraryDir, `${clipName}.json`),
      JSON.stringify(finalMeta, null, 2)
    );
    extracted++;
    logger.info('Extracted %s for pattern %s', clipName, pattern.key);
  }

  return extracted;
}
