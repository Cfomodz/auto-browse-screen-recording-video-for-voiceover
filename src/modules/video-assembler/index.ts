import * as fs from 'fs';
import * as path from 'path';
import { PipelineConfig, RecordedSegment, SfxEvent } from '../../core/types';
import { ZoomEngine } from '../../camera/zoom-engine';
import { Logger } from '../../utils/logger';
import { createLogger } from '../../utils/logger';
import { getVideoDuration, hasAudioStream } from '../../utils/video';
import { createSilentWav } from '../../utils/audio';

/**
 * A recorded segment placed on the master (voiceover) timeline.
 *
 * `start`/`end` are the resolved position of the clip's content after
 * overlap resolution — they may differ from the segment's transcript
 * window when topics overlap. `leadGap` is dead time between the previous
 * placement's end and this clip's start, filled by freezing this clip's
 * first frame. `tailPad` extends the clip's last frame (only ever set on
 * the final placement, to reach the end of the voiceover).
 */
interface PlacedSegment {
  seg: RecordedSegment;
  start: number;
  end: number;
  leadGap: number;
  tailPad: number;
}

/**
 * Video Assembler module.
 *
 * Takes the individual recorded screen clips and the voiceover audio,
 * applies dynamic zoom/pan effects and overlays SFX audio, then places
 * each clip AT ITS TRANSCRIPT TIME on a master timeline whose length is
 * the voiceover duration. Gaps between clips are filled by freezing
 * neighbouring frames, overlapping windows are resolved first-wins, and
 * the final mux never truncates the voiceover.
 *
 * Post-processing pipeline per clip:
 *   1. Apply zoom/pan filter (if zoom keyframes exist)
 *   2. Trim to the clip's placed window; freeze frames to fill gaps
 *   3. Mix in SFX audio events (click/typing sounds)
 *
 * Final assembly:
 *   4. Concatenate all processed clips (now spanning the full timeline)
 *   5. Mix voiceover audio + SFX track (no attenuation, no truncation)
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
      `[0:a]${sfxLabels}amix=inputs=${shiftedEvents.length + 1}:duration=first:dropout_transition=0:normalize=0[out]`,
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

    // The voiceover defines the master timeline: the final video must span
    // exactly its duration, with each clip placed at its transcript time.
    let timelineDuration: number;
    try {
      timelineDuration = await getVideoDuration(this.config.audioPath);
    } catch (err) {
      timelineDuration = segments.reduce((max, s) => Math.max(max, s.endTime), 0);
      this.logger.warn(
        `Could not probe voiceover duration (${(err as Error).message}); ` +
          `falling back to last segment end (${timelineDuration.toFixed(1)}s).`
      );
    }

    // Step 1: Place segments on the timeline (resolve overlaps, compute gaps)
    const placements = this.placeSegmentsOnTimeline(segments, timelineDuration);

    // Step 2: Process each clip (zoom + trim + gap fill)
    const processedPaths = await this.processClips(placements);

    if (processedPaths.length === 0) {
      this.logger.warn('No clips to assemble.');
      return outputPath;
    }

    // Step 3: Concatenate all processed clips (spans the full timeline)
    const concatPath = path.join(this.config.outputDir, 'concat_video.mp4');
    await this.concatenateClips(processedPaths, concatPath);

    // Step 4: Build the SFX audio track (if any clips have SFX events)
    const allSfxEvents = this.buildGlobalSfxTimeline(placements);
    let sfxTrackPath: string | null = null;

    if (allSfxEvents.length > 0) {
      sfxTrackPath = path.join(this.config.outputDir, 'sfx_track.wav');
      await this.buildSfxTrack(allSfxEvents, sfxTrackPath);
    }

    // Step 5: Mux voiceover + SFX + video
    await this.muxFinal(concatPath, this.config.audioPath, sfxTrackPath, outputPath);

    // Cleanup
    this.cleanup(processedPaths, concatPath, sfxTrackPath);

    this.logger.info(`Final video assembled: ${outputPath}`);
    return outputPath;
  }

  /**
   * Place segments on the master timeline.
   *
   * Sorted by transcript startTime; overlapping windows are resolved
   * first-wins (a later segment starts where the previous one ended, and is
   * dropped entirely if its window is consumed — e.g. a second action
   * recorded for the same topic window). Gaps before each clip and after the
   * last one are recorded so processClips can fill them with frozen frames,
   * making the concatenated video span exactly [0, timelineDuration].
   */
  private placeSegmentsOnTimeline(
    segments: RecordedSegment[],
    timelineDuration: number
  ): PlacedSegment[] {
    const MIN_WINDOW = 0.25; // seconds — drop slivers left over from overlaps

    const sorted = [...segments]
      .filter((seg) => {
        if (fs.existsSync(seg.filePath) && fs.statSync(seg.filePath).size > 0) return true;
        this.logger.warn(`Skipping empty clip: ${seg.filePath}`);
        return false;
      })
      .sort((a, b) => a.startTime - b.startTime);

    const placements: PlacedSegment[] = [];
    let cursor = 0;

    for (const seg of sorted) {
      const start = Math.max(seg.startTime, cursor);
      const end = Math.min(Math.max(seg.endTime, start), timelineDuration);

      if (end - start < MIN_WINDOW) {
        this.logger.info(
          `Dropping "${path.basename(seg.filePath)}" — window ` +
            `${seg.startTime.toFixed(1)}–${seg.endTime.toFixed(1)}s already covered or beyond voiceover.`
        );
        continue;
      }

      placements.push({ seg, start, end, leadGap: start - cursor, tailPad: 0 });
      cursor = end;
    }

    // Extend the last clip's final frame to the end of the voiceover.
    if (placements.length > 0 && timelineDuration - cursor > 0.01) {
      placements[placements.length - 1].tailPad = timelineDuration - cursor;
    }

    for (const p of placements) {
      this.logger.info(
        `Timeline: ${path.basename(p.seg.filePath)} @ ${p.start.toFixed(1)}–${p.end.toFixed(1)}s` +
          (p.leadGap > 0.01 ? ` (freeze-fill ${p.leadGap.toFixed(1)}s gap before)` : '') +
          (p.tailPad > 0.01 ? ` (hold last frame ${p.tailPad.toFixed(1)}s to end)` : '')
      );
    }

    return placements;
  }

  /**
   * Process each placed clip: apply zoom filter, trim content to its window,
   * and freeze first/last frames to fill timeline gaps. The output file's
   * duration is exactly leadGap + (end - start) + contentShortfall-pad + tailPad,
   * so concatenating all outputs reproduces the master timeline.
   */
  private async processClips(placements: PlacedSegment[]): Promise<string[]> {
    const ffmpeg = require('fluent-ffmpeg') as typeof import('fluent-ffmpeg');
    const processedPaths: string[] = [];

    for (let i = 0; i < placements.length; i++) {
      const { seg, start, end, leadGap, tailPad } = placements[i];
      const contentDuration = end - start;
      const processedPath = path.join(
        this.config.outputDir,
        'processed',
        `segment_${i}.mp4`
      );
      fs.mkdirSync(path.dirname(processedPath), { recursive: true });

      const actualDuration = await getVideoDuration(seg.filePath).catch(() => seg.durationSeconds);

      // Build video filters
      const videoFilters: string[] = [];

      // Zoom/pan filter — keyframes are relative to module start; shift by the
      // recording-start offset so they align with the actual video timeline.
      if (this.zoomEngine && seg.zoomKeyframes && seg.zoomKeyframes.length > 0) {
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

      // Trim content to the placed window. Never slow down the video — that
      // would desync SFX, clicks, and typing from visuals.
      videoFilters.push(`trim=duration=${contentDuration.toFixed(3)}`, 'setpts=PTS-STARTPTS');

      // Hold the last frame when the recording is shorter than its window,
      // plus any tail pad to reach the end of the voiceover; freeze the first
      // frame to fill the gap before this clip.
      const contentShortfall = Math.max(0, contentDuration - actualDuration);
      const stopPad = contentShortfall + tailPad;
      const slotDuration = leadGap + contentDuration + tailPad;

      if (leadGap > 0.001 || stopPad > 0.001) {
        const tpadArgs: string[] = [];
        if (leadGap > 0.001) tpadArgs.push(`start_mode=clone:start_duration=${leadGap.toFixed(3)}`);
        if (stopPad > 0.001) tpadArgs.push(`stop_mode=clone:stop_duration=${stopPad.toFixed(3)}`);
        videoFilters.push(`tpad=${tpadArgs.join(':')}`);
      }

      const inputHasAudio = seg.sfxBaked || (await hasAudioStream(seg.filePath));
      const audioFilters: string[] = [];
      if (inputHasAudio) {
        audioFilters.push(`atrim=duration=${contentDuration.toFixed(3)}`, 'asetpts=PTS-STARTPTS');
        if (leadGap > 0.001) {
          audioFilters.push(`adelay=${Math.round(leadGap * 1000)}:all=1`);
        }
        // Pad with silence to the exact slot length so audio and video stay
        // the same duration through concat.
        audioFilters.push(`apad=whole_dur=${slotDuration.toFixed(3)}`);
      }

      await new Promise<void>((resolve, reject) => {
        let cmd = ffmpeg().input(seg.filePath);

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
          outputOpts.push('-af', audioFilters.join(','), '-c:a', 'aac', '-b:a', '192k');
        } else {
          // Add silent audio so concat gets consistent streams (no lavfi)
          silencePath = createSilentWav(
            path.join(this.config.outputDir, 'tmp'),
            slotDuration
          );
          cmd = cmd.input(silencePath);
          outputOpts.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k');
        }

        // Pass -vf directly via outputOptions to preserve escaped commas in
        // zoom-engine crop expressions. fluent-ffmpeg's videoFilters() splits
        // on commas, which mangles the \, inside FFmpeg if() expressions.
        cmd = cmd.outputOptions(['-vf', videoFilters.join(',')]);

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
   * Build a global SFX timeline from each clip's placed position on the
   * master timeline. Events beyond a clip's trimmed window are dropped.
   * Skips segments that have SFX already baked into the clip.
   */
  private buildGlobalSfxTimeline(placements: PlacedSegment[]): SfxEvent[] {
    const globalEvents: SfxEvent[] = [];

    for (const { seg, start, end } of placements) {
      if (seg.sfxBaked || !seg.sfxEvents) continue;
      const window = end - start;
      for (const event of seg.sfxEvents) {
        if (event.timeOffset >= window) continue; // trimmed away with the video
        globalEvents.push({
          ...event,
          timeOffset: start + event.timeOffset,
        });
      }
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
        `${mixInputs}amix=inputs=${filterParts.length}:duration=longest:normalize=0[out]`,
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

      // duration=longest + normalize=0: never truncate the voiceover, never
      // attenuate it — each input keeps the gain it was given upstream.
      if (sfxTrackPath && fs.existsSync(sfxTrackPath) && fs.statSync(sfxTrackPath).size > 0) {
        // Three inputs: concat (video+audio with baked SFX), voiceover, extra SFX track
        cmd = cmd.input(sfxTrackPath);

        cmd
          .complexFilter([
            // Mix concat audio (baked SFX) + voiceover + extra SFX for non-baked segments
            '[0:a][1:a][2:a]amix=inputs=3:duration=longest:dropout_transition=0:normalize=0[aout]',
          ], ['aout'])
          .outputOptions([
            '-c:v copy',
            '-c:a aac',
            '-b:a 192k',
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
            '[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[aout]',
          ], ['aout'])
          .outputOptions([
            '-c:v copy',
            '-c:a aac',
            '-b:a 192k',
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
