import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import { VideoAssembler } from '../../src/modules/video-assembler';
import { PipelineConfig, RecordedSegment, ExtractedTopic } from '../../src/core/types';
import { createLogger } from '../../src/utils/logger';
import {
  ffprobe,
  audioHasContent,
  generateTestTone,
  generateTestVideo,
  makeTempDir,
  assertFileExists,
} from '../helpers';

const logger = createLogger('test');
logger.silent = true;

const WIDTH = 320;
const HEIGHT = 240;

function makeConfig(outputDir: string, audioPath: string): PipelineConfig {
  return {
    transcriptPath: 'unused.srt',
    audioPath,
    outputDir,
    viewport: { width: WIDTH, height: HEIGHT },
    searchEngine: 'google',
    llm: { provider: 'deepseek', apiKey: 'test' },
    modules: {
      'web-search': { enabled: true },
      'news-search': { enabled: false },
      'definition-search': { enabled: false },
      'image-search': { enabled: false },
    },
    mouseStyle: 'realistic',
    video: { fps: 30, resolution: { width: WIDTH, height: HEIGHT }, format: 'mp4' },
  };
}

function makeTopic(name: string, start: number, end: number): ExtractedTopic {
  return {
    topic: name,
    description: name,
    segments: [{ startTime: start, endTime: end, text: name }],
    suggestedActions: ['web-search'],
  };
}

function makeSegment(
  filePath: string,
  clipDurationSec: number,
  start: number,
  end: number
): RecordedSegment {
  return {
    topic: makeTopic(`topic-${start}`, start, end),
    action: 'web-search',
    filePath,
    durationSeconds: clipDurationSec,
    startTime: start,
    endTime: end,
  };
}

describe('VideoAssembler timeline assembly', () => {
  let tmpDir: string;
  let cleanup: () => void;
  let voiceoverPath: string;
  let clipA: string;
  let clipB: string;

  const VOICEOVER_SEC = 15;

  beforeAll(() => {
    const tmp = makeTempDir('assembler-test-');
    tmpDir = tmp.dir;
    cleanup = tmp.cleanup;

    voiceoverPath = path.join(tmpDir, 'voiceover.wav');
    // Stereo, like a real voiceover — mono would incur a -3 dB upmix in amix
    // that has nothing to do with the assembler's own gain handling.
    generateTestTone(voiceoverPath, { durationSec: VOICEOVER_SEC, frequency: 440, channels: 2 });

    clipA = path.join(tmpDir, 'clipA.mp4');
    clipB = path.join(tmpDir, 'clipB.mp4');
    generateTestVideo(clipA, { durationSec: 3, width: WIDTH, height: HEIGHT });
    generateTestVideo(clipB, { durationSec: 3, width: WIDTH, height: HEIGHT });
  });

  afterAll(() => cleanup());

  it('spans the full voiceover with gaps filled and no truncation', async () => {
    const outDir = path.join(tmpDir, 'out-gaps');
    const assembler = new VideoAssembler(makeConfig(outDir, voiceoverPath), logger);

    // Windows [2–5] and [10–12] leave gaps 0–2, 5–10, and 12–15.
    const segments: RecordedSegment[] = [
      makeSegment(clipA, 3, 2, 5),
      makeSegment(clipB, 3, 10, 12),
    ];

    const outputPath = await assembler.assemble(segments);
    assertFileExists(outputPath, 1000);

    const probe = ffprobe(outputPath);
    const duration = parseFloat(probe.format.duration);
    // Output must span the whole voiceover, not just the summed windows (5s).
    expect(duration).toBeGreaterThanOrEqual(VOICEOVER_SEC - 0.5);
    expect(duration).toBeLessThanOrEqual(VOICEOVER_SEC + 0.5);

    const codecTypes = probe.streams.map((s) => s.codec_type);
    expect(codecTypes).toContain('video');
    expect(codecTypes).toContain('audio');
  }, 120000);

  it('preserves voiceover level (no amix attenuation)', async () => {
    const outDir = path.join(tmpDir, 'out-level');
    const assembler = new VideoAssembler(makeConfig(outDir, voiceoverPath), logger);

    const outputPath = await assembler.assemble([makeSegment(clipA, 3, 0, 3)]);
    assertFileExists(outputPath, 1000);

    const source = audioHasContent(voiceoverPath);
    const output = audioHasContent(outputPath);
    // With normalize=0 the voiceover keeps its gain; the old amix behavior
    // attenuated it by 6 dB (2 inputs) or 9.5 dB (3 inputs).
    expect(output.peakDb).toBeGreaterThanOrEqual(source.peakDb - 1.5);
  }, 120000);

  it('drops fully-overlapped duplicate windows instead of double-covering', async () => {
    const outDir = path.join(tmpDir, 'out-overlap');
    const assembler = new VideoAssembler(makeConfig(outDir, voiceoverPath), logger);

    // Two actions recorded for the same topic window — only one may occupy it.
    const segments: RecordedSegment[] = [
      makeSegment(clipA, 3, 2, 5),
      makeSegment(clipB, 3, 2, 5),
    ];

    const outputPath = await assembler.assemble(segments);
    const probe = ffprobe(outputPath);
    const duration = parseFloat(probe.format.duration);
    expect(duration).toBeGreaterThanOrEqual(VOICEOVER_SEC - 0.5);
    expect(duration).toBeLessThanOrEqual(VOICEOVER_SEC + 0.5);
  }, 120000);
});
