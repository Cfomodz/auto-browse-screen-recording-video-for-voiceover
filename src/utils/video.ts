import * as child_process from 'child_process';
import * as path from 'path';

/** Result of measuring audio content level. */
export interface AudioLevel {
  peakDb: number;
  meanDb: number;
  isSilent: boolean;
}

/**
 * Measure audio level using ffmpeg volumedetect.
 * Use to verify a clip has actual audio content, not just a silent track.
 */
export function measureAudioLevel(filePath: string): AudioLevel {
  const result = child_process.spawnSync('ffmpeg', [
    '-i', path.resolve(filePath),
    '-af', 'volumedetect',
    '-f', 'null',
    '-',
  ], { encoding: 'utf-8', timeout: 15000 });

  const stderr = result.stderr || '';
  const peakMatch = stderr.match(/max_volume:\s*([-\d.]+)\s*dB/);
  const meanMatch = stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);

  const peakDb = peakMatch ? parseFloat(peakMatch[1]) : -Infinity;
  const meanDb = meanMatch ? parseFloat(meanMatch[1]) : -Infinity;

  // -45 dB: require reasonably audible SFX; -50 dB and below is hard to hear on most systems
  return {
    peakDb,
    meanDb,
    isSilent: peakDb < -45,
  };
}

/**
 * Get duration in seconds of a video file via ffprobe (fluent-ffmpeg).
 */
export function getVideoDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ffmpeg = require('fluent-ffmpeg') as typeof import('fluent-ffmpeg');
    ffmpeg.ffprobe(path.resolve(filePath), (err: Error | null, data: { format?: { duration?: number } }) => {
      if (err) return reject(err);
      const duration = data?.format?.duration;
      if (typeof duration !== 'number' || duration <= 0) {
        return reject(new Error(`No duration in ffprobe result for ${filePath}`));
      }
      resolve(duration);
    });
  });
}

/** Check if a media file has an audio stream. */
export function hasAudioStream(filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ffmpeg = require('fluent-ffmpeg') as typeof import('fluent-ffmpeg');
    ffmpeg.ffprobe(path.resolve(filePath), (err: Error | null, data: { streams?: { codec_type?: string }[] }) => {
      if (err) {
        resolve(false);
        return;
      }
      const hasAudio = (data?.streams ?? []).some((s) => s.codec_type === 'audio');
      resolve(hasAudio);
    });
  });
}
