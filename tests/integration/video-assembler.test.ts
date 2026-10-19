import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as child_process from 'child_process';
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

  it('plays every action recorded for one window, one after another', async () => {
    const outDir = path.join(tmpDir, 'out-overlap');
    const assembler = new VideoAssembler(makeConfig(outDir, voiceoverPath), logger);

    // Two actions recorded for the same topic window, visually distinct
    const red = path.join(tmpDir, 'red.mp4');
    const blue = path.join(tmpDir, 'blue.mp4');
    for (const [file, color] of [[red, 'red'], [blue, 'blue']]) {
      const gen = child_process.spawnSync('ffmpeg', [
        '-f', 'lavfi', '-i', `color=c=${color}:size=${WIDTH}x${HEIGHT}:rate=30:duration=3`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', file,
      ], { encoding: 'utf-8', timeout: 30000 });
      expect(gen.status).toBe(0);
    }

    const outputPath = await assembler.assemble([
      makeSegment(red, 3, 2, 5),
      makeSegment(blue, 3, 2, 5),
    ]);
    const probe = ffprobe(outputPath);
    const duration = parseFloat(probe.format.duration);
    expect(duration).toBeGreaterThanOrEqual(VOICEOVER_SEC - 0.5);
    expect(duration).toBeLessThanOrEqual(VOICEOVER_SEC + 0.5);

    /** Average RGB of the frame at time t. */
    const colorAt = (t: number): number[] => {
      const frame = child_process.spawnSync('ffmpeg', [
        '-ss', String(t), '-i', outputPath, '-frames:v', '1',
        '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
      ], { timeout: 30000 });
      return [...frame.stdout.subarray(0, 3)];
    };

    // Both play in full; the spare 9s is split as holds: red 0–7.5s, blue 7.5–15s
    const [r1, , b1] = colorAt(1);
    expect(r1).toBeGreaterThan(150);
    expect(b1).toBeLessThan(100);
    const [r2, , b2] = colorAt(9);
    expect(b2).toBeGreaterThan(150);
    expect(r2).toBeLessThan(100);
  }, 120000);
});

describe('VideoAssembler SFX levels', () => {
  let tmpDir: string;
  let cleanup: () => void;

  beforeAll(() => {
    const tmp = makeTempDir('sfx-level-test-');
    tmpDir = tmp.dir;
    cleanup = tmp.cleanup;
  });

  afterAll(() => cleanup());

  it('brings a quiet mono 192 kHz sample (like the typing library) up to the target level', async () => {
    // The bundled typing clips peak around -40 dBFS and are mono 192 kHz;
    // a plain volume multiplier left them inaudible.
    const tone = path.join(tmpDir, 'quiet_tone.wav');
    const quiet = path.join(tmpDir, 'quiet.wav');
    generateTestTone(tone, { durationSec: 0.5, frequency: 2000, sampleRate: 192000, channels: 1 });
    // lavfi's sine peaks at -18 dBFS; take it down to -40 dBFS
    const gen = child_process.spawnSync('ffmpeg', [
      '-i', tone, '-af', 'volume=-22dB', '-c:a', 'pcm_s16le', '-y', quiet,
    ], { encoding: 'utf-8', timeout: 15000 });
    expect(gen.status).toBe(0);

    const clip = path.join(tmpDir, 'clip.mp4');
    generateTestVideo(clip, { durationSec: 2, width: WIDTH, height: HEIGHT });

    const config: PipelineConfig = {
      ...makeConfig(tmpDir, quiet),
      sfx: {
        enabled: true,
        libraryPath: tmpDir,
        volume: 0.8,
        mouseClick: { enabled: false, samplesDir: 'clicks' },
        keyboardTyping: { enabled: true, samplesDir: 'typing' },
      },
    };
    const assembler = new VideoAssembler(config, logger);
    await assembler.bakeSfxIntoClip(clip, [
      { timeOffset: 0.5, type: 'typing', audioFile: quiet, durationSeconds: 0.5 },
    ]);

    // volume 0.8 → -12 dBFS + 20*log10(0.8) ≈ -14 dBFS
    const level = audioHasContent(clip);
    expect(level.peakDb).toBeGreaterThan(-15.5);
    expect(level.peakDb).toBeLessThan(-12.5);
  }, 60000);
});
