/**
 * Shared test helpers for validating real file outputs.
 */
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** FFprobe stream info. */
export interface ProbeResult {
  format: {
    filename: string;
    format_name: string;
    duration: string;
    size: string;
    bit_rate: string;
  };
  streams: Array<{
    codec_type: 'audio' | 'video';
    codec_name: string;
    sample_rate?: string;
    channels?: number;
    width?: number;
    height?: number;
    duration?: string;
    r_frame_rate?: string;
  }>;
}

/** Run ffprobe on a file and return parsed JSON. */
export function ffprobe(filePath: string): ProbeResult {
  const result = child_process.spawnSync('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ], { encoding: 'utf-8', timeout: 15000 });

  if (result.status !== 0) {
    throw new Error(`ffprobe failed on ${filePath}: ${result.stderr}`);
  }

  return JSON.parse(result.stdout);
}

/** Check if a WAV/audio file has actual audio content (not silence). */
export function audioHasContent(filePath: string): {
  peakDb: number;
  meanDb: number;
  isSilent: boolean;
} {
  // Use ffmpeg's volumedetect filter to measure peak and mean volume
  const result = child_process.spawnSync('ffmpeg', [
    '-i', filePath,
    '-af', 'volumedetect',
    '-f', 'null',
    '-',
  ], { encoding: 'utf-8', timeout: 15000 });

  const stderr = result.stderr || '';
  const peakMatch = stderr.match(/max_volume:\s*([-\d.]+)\s*dB/);
  const meanMatch = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);

  const peakDb = peakMatch ? parseFloat(peakMatch[1]) : -Infinity;
  const meanDb = meanMatch ? parseFloat(meanMatch[1]) : -Infinity;

  // Consider it silent if peak is below -60dB (essentially no signal)
  const isSilent = peakDb < -60;

  return { peakDb, meanDb, isSilent };
}

/** Generate a synthetic WAV file with a sine tone using FFmpeg. */
export function generateTestTone(
  outputPath: string,
  options?: { durationSec?: number; frequency?: number; sampleRate?: number }
): void {
  const { durationSec = 2, frequency = 440, sampleRate = 44100 } = options ?? {};
  const result = child_process.spawnSync('ffmpeg', [
    '-f', 'lavfi',
    '-i', `sine=frequency=${frequency}:duration=${durationSec}:sample_rate=${sampleRate}`,
    '-c:a', 'pcm_s16le',
    '-y',
    outputPath,
  ], { encoding: 'utf-8', timeout: 15000 });

  if (result.status !== 0) {
    throw new Error(`Failed to generate test tone: ${result.stderr}`);
  }
}

/** Generate a synthetic video file (color bars + silence) using FFmpeg. */
export function generateTestVideo(
  outputPath: string,
  options?: { durationSec?: number; width?: number; height?: number; fps?: number }
): void {
  const { durationSec = 3, width = 1920, height = 1080, fps = 30 } = options ?? {};
  const result = child_process.spawnSync('ffmpeg', [
    '-f', 'lavfi',
    '-i', `color=c=blue:s=${width}x${height}:d=${durationSec}:r=${fps}`,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'ultrafast',
    '-y',
    outputPath,
  ], { encoding: 'utf-8', timeout: 30000 });

  if (result.status !== 0) {
    throw new Error(`Failed to generate test video: ${result.stderr}`);
  }
}

/** Create a temporary directory that auto-cleans. Returns path and cleanup fn. */
export function makeTempDir(prefix: string = 'broll-test-'): {
  dir: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Assert a file exists and has size > minBytes. */
export function assertFileExists(filePath: string, minBytes: number = 1): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Expected file to exist: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (stat.size < minBytes) {
    throw new Error(
      `Expected file ${filePath} to be at least ${minBytes} bytes, got ${stat.size}`
    );
  }
}
