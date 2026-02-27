import * as path from 'path';

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
