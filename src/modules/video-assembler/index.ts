import * as fs from 'fs';
import * as path from 'path';
import { PipelineConfig, RecordedSegment, SfxEvent } from '../../core/types';
import { ZoomEngine } from '../../camera/zoom-engine';
import { Logger } from '../../utils/logger';
import { createLogger } from '../../utils/logger';
import { getVideoDuration, hasAudioStream } from '../../utils/video';
import { createSilentWav } from '../../utils/audio';

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

  /**
   * Bake SFX audio into a clip file immediately after recording.
   * Makes clips self-contained for debugging and progressive assembly.
   *
   * SFX timeOffsets are in real-time (seconds since module start). The video
   * may start slightly earlier (recording begins before the module), so we
   * shift events forward by the difference between video duration and module
   * duration rather than scaling — the concat-demuxer assembly preserves
   * real-time frame spacing, making the video timeline match wall-clock time.
   */
  async bakeSfxIntoClip(
    videoPath: string,
    sfxEvents: SfxEvent[],
    realDurationSeconds: number
  ): Promise<void> {
    if (!sfxEvents.length || !this.config.sfx?.enabled) return;

    const validEvents = sfxEvents.filter((e) => fs.existsSync(e.audioFile));
    if (validEvents.length === 0) return;

    const videoDuration = await getVideoDuration(videoPath).catch(() => realDurationSeconds);

    // Recording starts before the module (T0 < T1). SFX events are relative to
    // T1 (module start), but the video begins at T0. Shift events forward by the
    // gap so they land at the correct point in the video timeline.
    const recordingOffset = Math.max(0, videoDuration - realDurationSeconds);
    const shiftedEvents = validEvents.map((e) => ({
      ...e,
      timeOffset: e.timeOffset + recordingOffset,
    }));

    this.logger.debug(
      `Baking SFX into clip (${path.basename(videoPath)}): ${shiftedEvents.length} events, ` +
        `video ${videoDuration.toFixed(1)}s, real ${realDurationSeconds.toFixed(1)}s, offset +${recordingOffset.toFixed(3)}s`
    );
    for (let i = 0; i < shiftedEvents.length; i++) {
      const e = shiftedEvents[i];
      this.logger.debug(
        `  [${i}] ${e.type} @ ${e.timeOffset.toFixed(2)}s | ${path.basename(e.audioFile)} | ${e.durationSeconds.toFixed(2)}s`
      );
    }

    const ffmpeg = require('fluent-ffmpeg') as typeof import('fluent-ffmpeg');
    const tmpDir = path.join(this.config.outputDir, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const sfxTrackPath = path.join(tmpDir, `sfx_${path.basename(videoPath, '.mp4')}.wav`);
    const outPath = path.join(tmpDir, `baked_${path.basename(videoPath)}`);

    const sfxVolume = this.config.sfx.volume ?? 0.5;

    const sfxLabels = shiftedEvents.map((_, i) => `[sfx${i}]`).join('');
    const filterGraph = [
      ...shiftedEvents.map((event, i) => {
        const delayMs = Math.round(event.timeOffset * 1000);
        return `[${i + 1}:a]adelay=${delayMs}|${delayMs},volume=${sfxVolume}[sfx${i}]`;
      }),
      `[0:a]${sfxLabels}amix=inputs=${shiftedEvents.length + 1}:duration=first:dropout_transition=0[out]`,
    ].join(';');

    const silencePath = createSilentWav(tmpDir, videoDuration);

    try {
      await new Promise<void>((resolve, reject) => {
        let cmd = ffmpeg().input(silencePath);

        for (const e of shiftedEvents) cmd = cmd.input(e.audioFile);

        cmd
          .complexFilter(filterGraph, ['out'])
          .outputOptions(['-c:a pcm_s16le'])
          .output(sfxTrackPath)
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err))
          .run();
      });
    } catch (err) {
      this.logger.warn(`SFX track build failed: ${(err as Error).message}`);
      try {
        if (fs.existsSync(sfxTrackPath)) fs.unlinkSync(sfxTrackPath);
        if (fs.existsSync(silencePath)) fs.unlinkSync(silencePath);
      } catch {}
      throw err;
    }

    try {
      if (fs.existsSync(silencePath)) fs.unlinkSync(silencePath);
    } catch {}

    if (!fs.existsSync(sfxTrackPath) || fs.statSync(sfxTrackPath).size === 0) return;

    try {
      await new Promise<void>((resolve, reject) => {
        ffmpeg()
          .input(videoPath)
          .input(sfxTrackPath)
          .outputOptions(['-c:v copy', '-c:a aac', '-b:a 192k', '-shortest', '-map 0:v:0', '-map 1:a:0'])
          .output(outPath)
          .on('end', () => {
            fs.renameSync(outPath, videoPath);
            try {
              fs.unlinkSync(sfxTrackPath);
            } catch {}
            resolve();
          })
          .on('error', (err: Error) => reject(err))
          .run();
      });
    } catch (err) {
      try {
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
        if (fs.existsSync(sfxTrackPath)) fs.unlinkSync(sfxTrackPath);
      } catch {}
      this.logger.warn(`Bake SFX into clip failed: ${(err as Error).message}`);
      throw err;
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

      // Zoom/pan filter — keyframes are relative to module start; shift by the
      // recording-start offset so they align with the actual video timeline.
      if (this.zoomEngine && seg.zoomKeyframes && seg.zoomKeyframes.length > 0) {
        const actualDuration = await getVideoDuration(seg.filePath).catch(() => seg.durationSeconds);
        const zoomOffset = Math.max(0, actualDuration - seg.durationSeconds);
        const shiftedKeyframes = seg.zoomKeyframes.map((kf) => ({
          ...kf,
          timeOffset: kf.timeOffset + zoomOffset,
        }));
        const zoomFilter = this.zoomEngine.buildFilterChain(
          shiftedKeyframes,
          actualDuration,
          this.config.video.resolution.width,
          this.config.video.resolution.height,
          this.config.video.fps
        );
        if (zoomFilter) {
          videoFilters.push(zoomFilter);
        }
      }

      // Duration adjustment: trim if too long; hold last frame + pad audio if too short.
      // Never slow down the video — that would desync SFX, clicks, and typing from visuals.
      const padDuration =
        seg.durationSeconds < targetDuration && targetDuration - seg.durationSeconds > 0.05
          ? targetDuration - seg.durationSeconds
          : 0;

      if (padDuration > 0) {
        videoFilters.push(`tpad=stop_mode=clone:stop_duration=${padDuration.toFixed(3)}`);
      }

      const inputHasAudio = seg.sfxBaked || (await hasAudioStream(seg.filePath));
      const audioFilters: string[] = [];
      if (padDuration > 0 && inputHasAudio) {
        audioFilters.push(`apad=pad_dur=${padDuration.toFixed(3)}`);
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
          '-map 0:v:0',
        ];

        let silencePath: string | null = null;
        if (inputHasAudio) {
          outputOpts.push('-map', '0:a:0');
          if (audioFilters.length > 0) {
            outputOpts.push('-af', audioFilters.join(','), '-c:a', 'aac', '-b:a', '192k');
          } else {
            outputOpts.push('-c:a', 'aac', '-b:a', '192k');
          }
        } else {
          // Add silent audio so concat gets consistent streams (no lavfi)
          const silenceDuration = seg.endTime - seg.startTime;
          silencePath = createSilentWav(
            path.join(this.config.outputDir, 'tmp'),
            silenceDuration
          );
          cmd = cmd.input(silencePath);
          outputOpts.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k');
        }

        if (videoFilters.length > 0) {
          // Pass -vf directly via outputOptions to preserve escaped commas in
          // zoom-engine crop expressions. fluent-ffmpeg's videoFilters() splits
          // on commas, which mangles the \, inside FFmpeg if() expressions.
          cmd = cmd.outputOptions(['-vf', videoFilters.join(',')]);
        }

        cmd
          .outputOptions(outputOpts)
          .output(processedPath)
          .on('end', () => {
            try {
              if (silencePath && fs.existsSync(silencePath)) fs.unlinkSync(silencePath);
            } catch {}
            resolve();
          })
          .on('error', (err: Error) => {
            try {
              if (silencePath && fs.existsSync(silencePath)) fs.unlinkSync(silencePath);
            } catch {}
            reject(err);
          })
          .run();
      });

      processedPaths.push(processedPath);
    }

    return processedPaths;
  }

  /**
   * Build a global SFX timeline by adjusting each segment's SFX events
   * to account for the segment's position in the final video.
   * Skips segments that have SFX already baked into the clip.
   */
  private buildGlobalSfxTimeline(segments: RecordedSegment[]): SfxEvent[] {
    const globalEvents: SfxEvent[] = [];
    let cumulativeOffset = 0;

    for (const seg of segments) {
      if (!seg.sfxBaked && seg.sfxEvents) {
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
        // Three inputs: concat (video+audio with baked SFX), voiceover, extra SFX track
        cmd = cmd.input(sfxTrackPath);

        cmd
          .complexFilter([
            // Mix concat audio (baked SFX) + voiceover + extra SFX for non-baked segments
            '[0:a][1:a][2:a]amix=inputs=3:duration=shortest:dropout_transition=2[aout]',
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
        // Concat has video+audio (baked SFX); mix with voiceover
        cmd
          .complexFilter([
            '[0:a][1:a]amix=inputs=2:duration=shortest:dropout_transition=2[aout]',
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
