import * as fs from 'fs';
import * as path from 'path';
import { PipelineConfig, RecordedSegment, SfxEvent } from '../../core/types';
import { ZoomEngine } from '../../camera/zoom-engine';
import { Logger } from '../../utils/logger';
import { createLogger } from '../../utils/logger';

/**
 * Video Assembler module.
 *
 * Takes the individual recorded screen clips and the voiceover audio,
 * applies dynamic zoom/pan effects and overlays SFX audio, then
 * trims/extends each clip to match its corresponding transcript timing,
 * concatenates everything, and muxes the audio to produce the final video.
 *
 * Post-processing pipeline per clip:
 *   1. Apply zoom/pan filter (if zoom keyframes exist)
 *   2. Trim or speed-adjust to match transcript timing
 *   3. Mix in SFX audio events (click/typing sounds)
 *
 * Final assembly:
 *   4. Concatenate all processed clips
 *   5. Mix voiceover audio + SFX track
 *   6. Output final video
 */
export class VideoAssembler {
  private config: PipelineConfig;
  private logger: Logger;
  private zoomEngine: ZoomEngine | null = null;

  constructor(config: PipelineConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    if (config.camera?.enabled) {
      this.zoomEngine = new ZoomEngine(config.camera, createLogger('Zoom'));
    }
  }

  async assemble(segments: RecordedSegment[]): Promise<string> {
    this.logger.info(`Assembling ${segments.length} segments into final video...`);

    const outputPath = path.join(
      this.config.outputDir,
      `output.${this.config.video.format}`
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // Sort segments chronologically
    const sorted = [...segments].sort((a, b) => a.startTime - b.startTime);

    // Step 1: Process each clip (zoom + trim + SFX)
    const processedPaths = await this.processClips(sorted);

    if (processedPaths.length === 0) {
      this.logger.warn('No clips to assemble.');
      return outputPath;
    }

    // Step 2: Concatenate all processed clips
    const concatPath = path.join(this.config.outputDir, 'concat_video.mp4');
    await this.concatenateClips(processedPaths, concatPath);

    // Step 3: Build the SFX audio track (if any clips have SFX events)
    const allSfxEvents = this.buildGlobalSfxTimeline(sorted);
    let sfxTrackPath: string | null = null;

    if (allSfxEvents.length > 0) {
      sfxTrackPath = path.join(this.config.outputDir, 'sfx_track.wav');
      await this.buildSfxTrack(allSfxEvents, sfxTrackPath);
    }

    // Step 4: Mux voiceover + SFX + video
    await this.muxFinal(concatPath, this.config.audioPath, sfxTrackPath, outputPath);

    // Cleanup
    this.cleanup(processedPaths, concatPath, sfxTrackPath);

    this.logger.info(`Final video assembled: ${outputPath}`);
    return outputPath;
  }

  /**
   * Process each clip: apply zoom filter, trim to target duration.
   */
  private async processClips(segments: RecordedSegment[]): Promise<string[]> {
    const ffmpeg = require('fluent-ffmpeg') as typeof import('fluent-ffmpeg');
    const processedPaths: string[] = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const targetDuration = seg.endTime - seg.startTime;
      const processedPath = path.join(
        this.config.outputDir,
        'processed',
        `segment_${i}.mp4`
      );
      fs.mkdirSync(path.dirname(processedPath), { recursive: true });

      // Skip empty clip markers
      const stat = fs.statSync(seg.filePath);
      if (stat.size === 0) {
        this.logger.warn(`Skipping empty clip: ${seg.filePath}`);
        continue;
      }

      // Build video filters
      const videoFilters: string[] = [];

      // Zoom/pan filter
      if (this.zoomEngine && seg.zoomKeyframes && seg.zoomKeyframes.length > 0) {
        const zoomFilter = this.zoomEngine.buildFilterChain(
          seg.zoomKeyframes,
          seg.durationSeconds,
          this.config.video.resolution.width,
          this.config.video.resolution.height,
          this.config.video.fps
        );
        if (zoomFilter) {
          videoFilters.push(zoomFilter);
        }
      }

      // Duration adjustment
      if (seg.durationSeconds > targetDuration) {
        // Longer than needed — we'll trim via -t flag
      } else if (seg.durationSeconds < targetDuration * 0.5) {
        // Much shorter — slow down to fill
        const factor = seg.durationSeconds / targetDuration;
        videoFilters.push(`setpts=${(1 / factor).toFixed(3)}*PTS`);
      }

      await new Promise<void>((resolve, reject) => {
        let cmd = ffmpeg().input(seg.filePath);

        if (seg.durationSeconds > targetDuration) {
          cmd = cmd.duration(targetDuration);
        }

        const outputOpts = [
          '-c:v libx264',
          '-pix_fmt yuv420p',
          '-preset fast',
          '-crf 23',
          '-an',
        ];

        if (videoFilters.length > 0) {
          cmd = cmd.videoFilters(videoFilters.join(','));
        }

        cmd
          .outputOptions(outputOpts)
          .output(processedPath)
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err))
          .run();
      });

      processedPaths.push(processedPath);
    }

    return processedPaths;
  }

  /**
   * Build a global SFX timeline by adjusting each segment's SFX events
   * to account for the segment's position in the final video.
   */
  private buildGlobalSfxTimeline(segments: RecordedSegment[]): SfxEvent[] {
    const globalEvents: SfxEvent[] = [];
    let cumulativeOffset = 0;

    for (const seg of segments) {
      if (seg.sfxEvents) {
        for (const event of seg.sfxEvents) {
          globalEvents.push({
            ...event,
            timeOffset: cumulativeOffset + event.timeOffset,
          });
        }
      }
      cumulativeOffset += seg.endTime - seg.startTime;
    }

    return globalEvents;
  }

  /**
   * Build a composite SFX audio track by placing individual audio clips
   * at their target timestamps using FFmpeg's adelay + amix filters.
   */
  private async buildSfxTrack(events: SfxEvent[], outputPath: string): Promise<void> {
    if (events.length === 0) return;

    this.logger.info(`Building SFX track with ${events.length} events...`);
    const ffmpeg = require('fluent-ffmpeg') as typeof import('fluent-ffmpeg');

    // For each SFX event, we create an input and delay it to the right timestamp.
    // Then mix all delayed tracks together.
    return new Promise((resolve, reject) => {
      let cmd = ffmpeg();
      const filterParts: string[] = [];
      const sfxVolume = this.config.sfx?.volume ?? 0.5;

      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        if (!fs.existsSync(event.audioFile)) continue;

        cmd = cmd.input(event.audioFile);
        const delayMs = Math.round(event.timeOffset * 1000);
        // Delay this input, adjust volume, and label it
        filterParts.push(
          `[${i}:a]adelay=${delayMs}|${delayMs},volume=${sfxVolume}[sfx${i}]`
        );
      }

      if (filterParts.length === 0) {
        resolve();
        return;
      }

      // Mix all delayed SFX tracks together
      const mixInputs = filterParts.map((_, i) => `[sfx${i}]`).join('');
      const filterGraph = [
        ...filterParts,
        `${mixInputs}amix=inputs=${filterParts.length}:duration=longest[out]`,
      ].join(';');

      cmd
        .complexFilter(filterGraph, ['out'])
        .outputOptions(['-c:a pcm_s16le'])
        .output(outputPath)
        .on('end', () => {
          this.logger.info('SFX track built.');
          resolve();
        })
        .on('error', (err: Error) => {
          this.logger.warn(`SFX track build failed: ${err.message} — continuing without SFX.`);
          resolve(); // Non-fatal
        })
        .run();
    });
  }

  /**
   * Final mux: combine concatenated video, voiceover audio, and optional SFX track.
   */
  private async muxFinal(
    videoPath: string,
    voiceoverPath: string,
    sfxTrackPath: string | null,
    outputPath: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffmpeg = require('fluent-ffmpeg') as typeof import('fluent-ffmpeg');

      let cmd = ffmpeg()
        .input(videoPath)
        .input(voiceoverPath);

      if (sfxTrackPath && fs.existsSync(sfxTrackPath) && fs.statSync(sfxTrackPath).size > 0) {
        // Three inputs: video, voiceover, SFX
        cmd = cmd.input(sfxTrackPath);

        cmd
          .complexFilter([
            // Mix voiceover and SFX audio tracks
            '[1:a][2:a]amix=inputs=2:duration=shortest:dropout_transition=2[aout]',
          ], ['aout'])
          .outputOptions([
            '-c:v copy',
            '-c:a aac',
            '-b:a 192k',
            '-shortest',
            '-map 0:v:0',
          ])
          .output(outputPath)
          .on('end', () => {
            this.logger.info('Final video muxed with voiceover + SFX.');
            resolve();
          })
          .on('error', (err: Error) => reject(err))
          .run();
      } else {
        // Two inputs: video + voiceover only
        cmd
          .outputOptions([
            '-c:v copy',
            '-c:a aac',
            '-b:a 192k',
            '-shortest',
            '-map 0:v:0',
            '-map 1:a:0',
          ])
          .output(outputPath)
          .on('end', () => {
            this.logger.info('Final video muxed with voiceover.');
            resolve();
          })
          .on('error', (err: Error) => reject(err))
          .run();
      }
    });
  }

  private concatenateClips(clipPaths: string[], outputPath: string): Promise<void> {
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

  private cleanup(processedPaths: string[], concatPath: string, sfxTrackPath: string | null): void {
    try {
      for (const p of processedPaths) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      if (fs.existsSync(concatPath)) fs.unlinkSync(concatPath);
      if (sfxTrackPath && fs.existsSync(sfxTrackPath)) fs.unlinkSync(sfxTrackPath);

      const processedDir = path.join(this.config.outputDir, 'processed');
      if (fs.existsSync(processedDir)) fs.rmdirSync(processedDir);
    } catch {
      // Non-critical cleanup
    }
  }
}
