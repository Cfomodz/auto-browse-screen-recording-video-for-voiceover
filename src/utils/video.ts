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
