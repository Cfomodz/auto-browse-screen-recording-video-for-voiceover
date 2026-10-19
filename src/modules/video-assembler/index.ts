import * as fs from 'fs';
import * as path from 'path';
import { PipelineConfig, RecordedSegment, SfxEvent } from '../../core/types';
import { ZoomEngine } from '../../camera/zoom-engine';
import { Logger } from '../../utils/logger';
import { createLogger } from '../../utils/logger';
import { getVideoDuration, hasAudioStream, measureAudioLevel } from '../../utils/video';
import { createSilentWav } from '../../utils/audio';

/**
 * A recorded segment placed on the master (voiceover) timeline.
 *
 * The clip plays from its first frame at `start`; if it runs out before
 * `end`, its last frame holds. Placements tile [0, voiceover duration]
 * with no gaps or overlaps.
 */
export interface PlacedSegment {
  seg: RecordedSegment;
  start: number;
  end: number;
}

/** Windows shorter than this are not worth a cut (seconds). */
const MIN_WINDOW = 0.25;
/**
 * Least screen time worth giving a clip that shares its window (seconds).
 * Every module spends its first ~7s moving to the search box, typing, and
 * loading results, so a shorter slice shows nothing that tells clips apart.
 */
const MIN_CLIP_SHARE = 12;

/**
 * Place segments on the master timeline.
 *
 * - Overlapping windows of different topics resolve first-wins: a later
 *   window starts where the earlier one ended, and is dropped if nothing is
 *   left of it.
 * - Each topic's clips get its window plus any gap before the next topic
 *   (the first topic also takes the time before it), so placements tile
 *   [0, voiceover duration] with no gaps or overlaps.
 * - Clips recorded for the same window (several actions for one topic) play
 *   one after another. As many are kept as can each get MIN_CLIP_SHARE (or
 *   their full length if shorter); the time is shared max-min fairly, so a
 *   short clip plays in full and long ones split the rest.
 *
 * Segments with a missing or empty file must be filtered out beforehand.
 */
export function placeSegmentsOnTimeline(
  segments: RecordedSegment[],
  timelineDuration: number,
  log: (message: string) => void = () => {}
): PlacedSegment[] {
  const drop = (seg: RecordedSegment, why: string) =>
    log(`Dropping "${path.basename(seg.filePath)}" — ${why}.`);

  // Group clips by transcript window, keeping recording order within a group
  const groups: RecordedSegment[][] = [];
  for (const seg of segments) {
    const group = groups.find(
      (g) => g[0].startTime === seg.startTime && g[0].endTime === seg.endTime
    );
    if (group) group.push(seg);
    else groups.push([seg]);
  }
  groups.sort((a, b) => a[0].startTime - b[0].startTime);

  // First-wins: each kept window starts where the previous one ended
  const kept: Array<{ clips: RecordedSegment[]; start: number }> = [];
  let cursor = 0;
  for (const group of groups) {
    const start = Math.max(group[0].startTime, cursor);
    const end = Math.min(group[0].endTime, timelineDuration);
    if (end - start < MIN_WINDOW) {
      const window = `${group[0].startTime.toFixed(1)}–${group[0].endTime.toFixed(1)}s`;
      for (const seg of group) drop(seg, `window ${window} already covered or beyond voiceover`);
      continue;
    }
    kept.push({ clips: group, start });
    cursor = end;
  }

  const placements: PlacedSegment[] = [];
  for (let k = 0; k < kept.length; k++) {
    const spanStart = k === 0 ? 0 : kept[k].start;
    const spanEnd = k + 1 < kept.length ? kept[k + 1].start : timelineDuration;
    const span = spanEnd - spanStart;

    // Keep the leading clips that fit with at least their minimum screen time
    const clips: RecordedSegment[] = [];
    let needed = 0;
    for (const seg of kept[k].clips) {
      const minimum = Math.min(MIN_CLIP_SHARE, Math.max(seg.durationSeconds, 0));
      if (clips.length > 0 && needed + minimum > span) {
        drop(seg, `${span.toFixed(1)}s window is too short to also show it`);
        continue;
      }
      clips.push(seg);
      needed += minimum;
    }

    const shares = fairShares(clips.map((seg) => Math.max(seg.durationSeconds, 0)), span);
    let start = spanStart;
    clips.forEach((seg, i) => {
      const end = i === clips.length - 1 ? spanEnd : start + shares[i];
      placements.push({ seg, start, end });
      start = end;
    });
  }
  return placements;
}

/**
 * Split `total` seconds among clips max-min fairly: clips shorter than an
 * even split play in full, the rest share what remains. Time left over when
 * every clip fits is spread evenly as holds on each clip's last frame.
 */
function fairShares(durations: number[], total: number): number[] {
  const shares = durations.map(() => 0);
  const order = durations.map((_, i) => i).sort((a, b) => durations[a] - durations[b]);
  let remaining = total;
  order.forEach((i, rank) => {
    shares[i] = Math.min(durations[i], remaining / (order.length - rank));
    remaining -= shares[i];
  });
  return shares.map((share) => share + remaining / Math.max(shares.length, 1));
}

/** Peak level an SFX sample is normalized to at sfx.volume = 1.0 (dBFS). */
const SFX_TARGET_PEAK_DB = -12;
/** Most gain normalization may add, so near-silent samples don't turn into hiss. */
const SFX_MAX_BOOST_DB = 40;
/** SFX peaks never go above this, whatever sfx.volume says. */
const SFX_CEILING_DB = -1;
/**
 * Format every SFX sample is converted to before mixing. Levels are measured
 * after this conversion: upmixing mono costs 3 dB and resampling a 192 kHz
 * recording shaves keystroke transients, so the file's own peak overstates
 * what is heard.
 */
const SFX_MIX_FORMAT = 'aresample=44100,aformat=channel_layouts=stereo';

/**
 * Video Assembler module.
 *
 * Takes the individual recorded screen clips and the voiceover audio,
 * applies dynamic zoom/pan effects and overlays SFX audio, then places
 * each clip AT ITS TRANSCRIPT TIME on a master timeline whose length is
 * the voiceover duration (see placeSegmentsOnTimeline). The final mux
 * never truncates the voiceover.
 *
 * Post-processing pipeline per clip:
 *   1. Apply zoom/pan filter (if zoom keyframes exist)
 *   2. Trim to the clip's slot; hold its last frame if it runs out
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
  /** Measured peak level (dBFS) of each SFX sample. */
  private sfxPeakDb = new Map<string, number>();

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
   * SFX timeOffsets must already be on the clip's video timeline (seconds
   * since recording started) — the pipeline shifts module-relative times
   * by the measured gap between recording start and module start.
   */
  async bakeSfxIntoClip(videoPath: string, sfxEvents: SfxEvent[]): Promise<void> {
    if (!sfxEvents.length || !this.config.sfx?.enabled) return;

    const shiftedEvents = sfxEvents.filter((e) => fs.existsSync(e.audioFile));
    if (shiftedEvents.length === 0) return;

    const videoDuration = await getVideoDuration(videoPath);

    this.logger.debug(
      `Baking SFX into clip (${path.basename(videoPath)}): ${shiftedEvents.length} events, ` +
        `video ${videoDuration.toFixed(1)}s`
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

    const sfxLabels = shiftedEvents.map((_, i) => `[sfx${i}]`).join('');
    const filterGraph = [
      ...shiftedEvents.map((event, i) => {
        return this.sfxEventFilter(`${i + 1}:a`, event, `sfx${i}`);
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

  /**
   * Linear gain for an SFX sample: normalizes its peak to SFX_TARGET_PEAK_DB,
   * scales by sfx.volume, and never lets the peak exceed SFX_CEILING_DB.
   * Samples are recorded at very different levels (the bundled typing clips
   * peak around -40 dBFS), so a plain multiplier either buries them or clips.
   */
  private sfxGain(audioFile: string): number {
    let peakDb = this.sfxPeakDb.get(audioFile);
    if (peakDb === undefined) {
      peakDb = measureAudioLevel(audioFile, SFX_MIX_FORMAT).peakDb;
      this.sfxPeakDb.set(audioFile, peakDb);
    }
    const volume = Math.max(this.config.sfx?.volume ?? 0.5, 1e-6);
    if (!Number.isFinite(peakDb)) return volume; // silent or unreadable sample

    const normalizeDb = Math.min(SFX_TARGET_PEAK_DB - peakDb, SFX_MAX_BOOST_DB);
    const gainDb = Math.min(normalizeDb + 20 * Math.log10(volume), SFX_CEILING_DB - peakDb);
    return Math.pow(10, gainDb / 20);
  }

  /**
   * Filter chain placing one SFX event: play only `durationSeconds` of the
   * sample (with a short fade so the cut is silent), delay it to its time,
   * and set its level.
   */
  private sfxEventFilter(input: string, event: SfxEvent, label: string): string {
    const playFor = Math.max(event.durationSeconds, 0.05);
    const fade = Math.min(0.04, playFor / 2);
    const delayMs = Math.round(Math.max(event.timeOffset, 0) * 1000);
    return (
      `[${input}]${SFX_MIX_FORMAT},atrim=end=${playFor.toFixed(3)},` +
      `afade=t=out:st=${(playFor - fade).toFixed(3)}:d=${fade.toFixed(3)},` +
      `adelay=${delayMs}|${delayMs},volume=${this.sfxGain(event.audioFile).toFixed(4)}[${label}]`
    );
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

    // Step 1: Place segments on the timeline (resolve overlaps, close gaps)
    const playable = segments.filter((seg) => {
      if (fs.existsSync(seg.filePath) && fs.statSync(seg.filePath).size > 0) return true;
      this.logger.warn(`Skipping empty clip: ${seg.filePath}`);
      return false;
    });
    const placements = placeSegmentsOnTimeline(playable, timelineDuration, (m) => this.logger.info(m));
    for (const p of placements) {
      this.logger.info(
        `Timeline: ${path.basename(p.seg.filePath)} @ ${p.start.toFixed(1)}–${p.end.toFixed(1)}s` +
          (p.end - p.start > p.seg.durationSeconds + 0.05
            ? ` (holds last frame ${(p.end - p.start - p.seg.durationSeconds).toFixed(1)}s)`
            : '')
      );
    }

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
   * Process each placed clip: apply the zoom filter, trim it to its slot,
   * and hold its last frame if it runs out before the slot ends. Each output
   * is exactly as long as its slot, so concatenating all outputs reproduces
   * the master timeline.
   */
  private async processClips(placements: PlacedSegment[]): Promise<string[]> {
    const ffmpeg = require('fluent-ffmpeg') as typeof import('fluent-ffmpeg');
    const processedPaths: string[] = [];

    for (let i = 0; i < placements.length; i++) {
      const { seg, start, end } = placements[i];
      const slotDuration = end - start;
      const processedPath = path.join(
        this.config.outputDir,
        'processed',
        `segment_${i}.mp4`
      );
      fs.mkdirSync(path.dirname(processedPath), { recursive: true });

      const actualDuration = await getVideoDuration(seg.filePath).catch(() => seg.durationSeconds);
      const contentDuration = Math.min(slotDuration, actualDuration);

      // Trim content to the slot first so the zoom only renders frames that
      // are kept. Never slow down the video — that would desync SFX, clicks,
      // and typing from visuals.
      const { width, height } = this.config.video.resolution;
      const videoFilters: string[] = [
        `trim=duration=${contentDuration.toFixed(3)}`,
        'setpts=PTS-STARTPTS',
        // Clips from older runs may have another size; concat needs them equal
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1`,
      ];

      // Zoom/pan filter — keyframes are already on the clip's video timeline
      if (this.zoomEngine && seg.zoomKeyframes && seg.zoomKeyframes.length > 0) {
        const zoomFilter = this.zoomEngine.buildFilterChain(
          seg.zoomKeyframes,
          contentDuration,
          width,
          height,
          this.config.video.fps
        );
        if (zoomFilter) {
          videoFilters.push(zoomFilter);
        }
      }

      // Hold the last frame when the recording is shorter than its slot
      const holdDuration = slotDuration - contentDuration;
      if (holdDuration > 0.001) {
        videoFilters.push(`tpad=stop_mode=clone:stop_duration=${holdDuration.toFixed(3)}`);
      }

      const inputHasAudio = seg.sfxBaked || (await hasAudioStream(seg.filePath));
      const audioFilters: string[] = [];
      if (inputHasAudio) {
        audioFilters.push(`atrim=duration=${contentDuration.toFixed(3)}`, 'asetpts=PTS-STARTPTS');
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
        // zoom-engine expressions. fluent-ffmpeg's videoFilters() splits
        // on commas, which mangles the \, inside FFmpeg expressions.
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
      const shown = Math.min(end - start, seg.durationSeconds);
      for (const event of seg.sfxEvents) {
        if (event.timeOffset >= shown) continue; // trimmed away with the video
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
      const playable = events.filter((event) => fs.existsSync(event.audioFile));

      for (let i = 0; i < playable.length; i++) {
        const event = playable[i];
        cmd = cmd.input(event.audioFile);
        filterParts.push(this.sfxEventFilter(`${i}:a`, event, `sfx${i}`));
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
