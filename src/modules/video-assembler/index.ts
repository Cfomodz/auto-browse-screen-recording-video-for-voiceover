import * as fs from 'fs';
import * as path from 'path';
import { PipelineConfig, RecordedSegment } from '../../core/types';
import { Logger } from '../../utils/logger';

/**
 * Video Assembler module.
 *
 * Takes the individual recorded screen clips and the voiceover audio,
 * trims/extends each clip to match its corresponding transcript timing,
 * then concatenates everything and muxes the audio to produce the final
 * output video.
 */
export class VideoAssembler {
  private config: PipelineConfig;
  private logger: Logger;

  constructor(config: PipelineConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Assemble all recorded segments into a single video with the voiceover audio.
   *
   * Process:
   * 1. Sort segments by their transcript start time
   * 2. Trim or speed-adjust each clip to fit its assigned time window
   * 3. Concatenate clips in order
   * 4. Overlay the voiceover audio track
   * 5. Output the final video
   */
  async assemble(segments: RecordedSegment[]): Promise<string> {
    this.logger.info(`Assembling ${segments.length} segments into final video...`);

    const outputPath = path.join(
      this.config.outputDir,
      `output.${this.config.video.format}`
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // Sort segments chronologically
    const sorted = [...segments].sort((a, b) => a.startTime - b.startTime);

    // Step 1: Trim each clip to match its target duration
    const trimmedPaths = await this.trimClips(sorted);

    // Step 2: Concatenate all trimmed clips
    const concatPath = path.join(this.config.outputDir, 'concat_video.mp4');
    await this.concatenateClips(trimmedPaths, concatPath);

    // Step 3: Mux the voiceover audio onto the concatenated video
    await this.muxAudio(concatPath, this.config.audioPath, outputPath);

    // Cleanup intermediate files
    this.cleanup(trimmedPaths, concatPath);

    this.logger.info(`Final video assembled: ${outputPath}`);
    return outputPath;
  }

  private async trimClips(segments: RecordedSegment[]): Promise<string[]> {
    const ffmpeg = require('fluent-ffmpeg') as typeof import('fluent-ffmpeg');
    const trimmedPaths: string[] = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const targetDuration = seg.endTime - seg.startTime;
      const trimmedPath = path.join(
        this.config.outputDir,
        'trimmed',
        `segment_${i}.mp4`
      );
      fs.mkdirSync(path.dirname(trimmedPath), { recursive: true });

      // Skip empty clip markers
      const stat = fs.statSync(seg.filePath);
      if (stat.size === 0) {
        this.logger.warn(`Skipping empty clip: ${seg.filePath}`);
        continue;
      }

      await new Promise<void>((resolve, reject) => {
        let cmd = ffmpeg().input(seg.filePath);

        if (seg.durationSeconds > targetDuration) {
          // Clip is longer than needed — trim it
          cmd = cmd.duration(targetDuration);
        } else if (seg.durationSeconds < targetDuration * 0.5) {
          // Clip is much shorter — slow it down to fill the time
          const factor = seg.durationSeconds / targetDuration;
          cmd = cmd.videoFilters(`setpts=${(1 / factor).toFixed(3)}*PTS`);
        }
        // If clip is roughly the right length, use as-is

        cmd
          .outputOptions([
            '-c:v libx264',
            '-pix_fmt yuv420p',
            '-preset fast',
            '-an',  // Strip audio — we'll add voiceover later
          ])
          .output(trimmedPath)
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err))
          .run();
      });

      trimmedPaths.push(trimmedPath);
    }

    return trimmedPaths;
  }

  private async concatenateClips(clipPaths: string[], outputPath: string): Promise<void> {
    // Create a concat file list for FFmpeg
    const listPath = path.join(this.config.outputDir, 'concat_list.txt');
    const listContent = clipPaths
      .map((p) => `file '${path.resolve(p)}'`)
      .join('\n');
    fs.writeFileSync(listPath, listContent);

    return new Promise((resolve, reject) => {
      const ffmpeg = require('fluent-ffmpeg') as typeof import('fluent-ffmpeg');

      ffmpeg()
        .input(listPath)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions(['-c copy'])
        .output(outputPath)
        .on('end', () => {
          fs.unlinkSync(listPath);
          resolve();
        })
        .on('error', (err: Error) => reject(err))
        .run();
    });
  }

  private async muxAudio(
    videoPath: string,
    audioPath: string,
    outputPath: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffmpeg = require('fluent-ffmpeg') as typeof import('fluent-ffmpeg');

      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .outputOptions([
          '-c:v copy',
          '-c:a aac',
          '-b:a 192k',
          '-shortest',  // End at whichever track is shorter
          '-map 0:v:0',
          '-map 1:a:0',
        ])
        .output(outputPath)
        .on('end', () => {
          this.logger.info('Audio muxed successfully.');
          resolve();
        })
        .on('error', (err: Error) => reject(err))
        .run();
    });
  }

  private cleanup(trimmedPaths: string[], concatPath: string): void {
    try {
      for (const p of trimmedPaths) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      if (fs.existsSync(concatPath)) fs.unlinkSync(concatPath);

      const trimmedDir = path.join(this.config.outputDir, 'trimmed');
      if (fs.existsSync(trimmedDir)) fs.rmdirSync(trimmedDir);
    } catch {
      // Non-critical cleanup
    }
  }
}
