import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import {
  ExtractedTopic,
  ModuleActionType,
  PipelineConfig,
  PipelineEvent,
  PipelineResult,
  RecordedSegment,
  SfxEvent,
  TranscriptSegment,
  ZoomKeyframe,
} from './types';
import { BrollModule, ModuleRegistry } from './module';
import { BrowserEngine } from '../browser/engine';
import { TranscriptAnalyzer } from '../modules/transcript-analyzer';
import { ScreenRecorder } from '../modules/screen-recorder';
import { VideoAssembler } from '../modules/video-assembler';
import { WebSearchModule } from '../modules/web-search';
import { NewsSearchModule } from '../modules/news-search';
import { DefinitionSearchModule } from '../modules/definition-search';
import { ImageSearchModule } from '../modules/image-search';
import { SfxManager } from '../sfx/manager';
import { parseTranscript } from '../utils/transcript-parser';
import { getVideoDuration, hasAudioStream, measureAudioLevel } from '../utils/video';
import { createLogger, Logger } from '../utils/logger';

const TOPICS_CACHE_FILE = 'topics-cache.json';
const CLIPS_DIR = 'clips';

/**
 * Main pipeline orchestrator.
 *
 * Coordinates the full flow:
 *   transcript -> LLM topic extraction -> browser actions + screen recording -> video assembly
 *
 * Now also manages:
 *   - SFX overlay (click sounds, typing audio)
 *   - Dynamic camera zoom keyframes per clip
 */
export class Pipeline extends EventEmitter {
  private config: PipelineConfig;
  private logger: Logger;
  private registry: ModuleRegistry;
  private browser: BrowserEngine;
  private recorder: ScreenRecorder;
  private analyzer: TranscriptAnalyzer;
  private assembler: VideoAssembler;
  private sfxManager: SfxManager | null = null;

  constructor(config: PipelineConfig) {
    super();
    this.config = config;
    this.logger = createLogger('Pipeline');

    // Initialize SFX manager if configured
    if (config.sfx?.enabled) {
      this.sfxManager = new SfxManager(config.sfx, createLogger('SFX'));
    }

    // Initialize browser engine (with SFX manager for click/type sounds)
    this.browser = new BrowserEngine(
      config,
      createLogger('Browser'),
      this.sfxManager ?? undefined
    );

    // Initialize recorder
    this.recorder = new ScreenRecorder(config, createLogger('Recorder'));

    // Initialize LLM analyzer
    this.analyzer = new TranscriptAnalyzer(config, createLogger('Analyzer'));

    // Initialize video assembler (with camera and SFX config)
    this.assembler = new VideoAssembler(config, createLogger('Assembler'));

    // Register all enabled modules
    this.registry = new ModuleRegistry();
    this.registerModules();
  }

  private registerModules(): void {
    const { modules } = this.config;

    if (modules['web-search']) {
      this.registry.register(
        new WebSearchModule(modules['web-search'], createLogger('WebSearch'))
      );
    }
    if (modules['news-search']) {
      this.registry.register(
        new NewsSearchModule(modules['news-search'], createLogger('NewsSearch'))
      );
    }
    if (modules['definition-search']) {
      this.registry.register(
        new DefinitionSearchModule(modules['definition-search'], createLogger('DefSearch'))
      );
    }
    if (modules['image-search']) {
      this.registry.register(
        new ImageSearchModule(modules['image-search'], createLogger('ImageSearch'))
      );
    }
  }

  private emit_event(event: PipelineEvent): void {
    this.emit('event', event);
  }

  async run(options?: { noCacheTopics?: boolean }): Promise<PipelineResult> {
    fs.mkdirSync(this.config.outputDir, { recursive: true });
    const clipsDir = path.join(this.config.outputDir, CLIPS_DIR);
    fs.mkdirSync(clipsDir, { recursive: true });

    // Step 1: Parse transcript
    this.logger.info(`Parsing transcript: ${this.config.transcriptPath}`);
    const segments = parseTranscript(this.config.transcriptPath);
    this.logger.info(`Parsed ${segments.length} transcript segments.`);

    // Step 2: Analyze transcript for topics (or load from cache)
    this.emit_event({ type: 'analysis-start' });
    let topics: ExtractedTopic[];
    const cachePath = path.join(this.config.outputDir, TOPICS_CACHE_FILE);
    const transcriptStat = fs.statSync(this.config.transcriptPath);
    const transcriptMtime = transcriptStat.mtimeMs;

    if (!options?.noCacheTopics && fs.existsSync(cachePath)) {
      this.logger.debug(`Checking topics cache: ${cachePath}`);
      try {
        const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        if (
          raw.transcriptPath === this.config.transcriptPath &&
          raw.transcriptMtime === transcriptMtime
        ) {
          topics = raw.topics as ExtractedTopic[];
          this.logger.info(`Using cached topics (${topics.length}) from ${cachePath}`);
          this.emit_event({ type: 'analysis-complete', topics });
        } else {
          this.logger.debug('Topics cache stale or transcript path changed; re-analyzing.');
          topics = await this.runAnalyzerAndCache(segments, cachePath, transcriptMtime);
        }
      } catch (e) {
        this.logger.debug(`Topics cache read failed: ${e}; re-analyzing.`);
        topics = await this.runAnalyzerAndCache(segments, cachePath, transcriptMtime);
      }
    } else {
      if (options?.noCacheTopics) this.logger.debug('--no-cache-topics: re-analyzing.');
      topics = await this.runAnalyzerAndCache(segments, cachePath, transcriptMtime);
    }

    // Step 3: For each topic, run enabled module actions with screen recording
    // (or use existing clip). The browser is launched on the first recording.
    const recordedSegments: RecordedSegment[] = [];

    try {
      for (const topic of topics) {
        for (const actionType of topic.suggestedActions) {
          const mod = this.registry.get(actionType);
          if (!mod || !mod.enabled) continue;

          const clipName = this.sanitizeFilename(`${topic.topic}_${actionType}`);
          const existing = await this.pickupExistingClip(topic, actionType, clipName, clipsDir);
          recordedSegments.push(
            existing ?? (await this.recordClip(mod, topic, actionType, clipName))
          );
        }
      }
    } finally {
      await this.browser.close();
    }

    // Step 4: Assemble final video
    this.emit_event({ type: 'assembly-start' });
    const outputPath = await this.assembler.assemble(recordedSegments);
    this.emit_event({ type: 'assembly-complete', outputPath });

    const totalDuration = recordedSegments.reduce(
      (sum, s) => sum + s.durationSeconds,
      0
    );

    return {
      outputPath,
      segments: recordedSegments,
      durationSeconds: totalDuration,
    };
  }

  /**
   * Load or compute topics (from cache or analyzer). Used by runOne and for --list-topics.
   */
  async getTopics(options?: { noCacheTopics?: boolean }): Promise<ExtractedTopic[]> {
    const segments = parseTranscript(this.config.transcriptPath);
    const cachePath = path.join(this.config.outputDir, TOPICS_CACHE_FILE);
    const transcriptStat = fs.statSync(this.config.transcriptPath);
    const transcriptMtime = transcriptStat.mtimeMs;

    if (!options?.noCacheTopics && fs.existsSync(cachePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
        if (
          raw.transcriptPath === this.config.transcriptPath &&
          raw.transcriptMtime === transcriptMtime
        ) {
          const topics = (raw.topics as ExtractedTopic[]).map((t) => ({
            ...t,
            topic: t.topic.toLowerCase(),
          }));
          return topics;
        }
      } catch {
        // fall through to analyze
      }
    }
    return this.runAnalyzerAndCache(segments, cachePath, transcriptMtime);
  }

  /**
   * Run a single module for a single topic: resolve topics (cache ok),
   * then record only the specified (topicIndex, action). No assembly. For debugging / iteration.
   */
  async runOne(options: {
    topicIndex: number;
    action: ModuleActionType;
    noCacheTopics?: boolean;
  }): Promise<RecordedSegment> {
    fs.mkdirSync(this.config.outputDir, { recursive: true });
    const clipsDir = path.join(this.config.outputDir, CLIPS_DIR);
    fs.mkdirSync(clipsDir, { recursive: true });

    const topics = await this.getTopics({ noCacheTopics: options.noCacheTopics });
    this.logger.debug(`Resolved ${topics.length} topics.`);

    const topicIndex = options.topicIndex;
    if (topicIndex < 0 || topicIndex >= topics.length) {
      throw new Error(
        `Topic index ${topicIndex} out of range (0–${topics.length - 1}). Run with --list-topics to see indices.`
      );
    }
    const topic = topics[topicIndex];
    const actionType = options.action;

    if (!topic.suggestedActions.includes(actionType)) {
      throw new Error(
        `Topic "${topic.topic}" does not have action "${actionType}". Suggested: ${topic.suggestedActions.join(', ')}`
      );
    }

    const mod = this.registry.get(actionType);
    if (!mod || !mod.enabled) {
      throw new Error(`Module "${actionType}" is not enabled in config.`);
    }

    const clipName = this.sanitizeFilename(`${topic.topic}_${actionType}`);
    const existing = await this.pickupExistingClip(topic, actionType, clipName, clipsDir);
    if (existing) return existing;

    try {
      return await this.recordClip(mod, topic, actionType, clipName);
    } finally {
      await this.browser.close();
    }
  }

  /**
   * Reuse a clip recorded by an earlier run, restoring its zoom keyframes
   * from the timing JSON. Returns null when the clip must be (re-)recorded.
   */
  private async pickupExistingClip(
    topic: ExtractedTopic,
    actionType: ModuleActionType,
    clipName: string,
    clipsDir: string
  ): Promise<RecordedSegment | null> {
    const existingPath = path.join(clipsDir, `${clipName}.mp4`);
    if (!fs.existsSync(existingPath) || fs.statSync(existingPath).size === 0) return null;

    const hasAudio = await hasAudioStream(existingPath);
    if (this.config.sfx?.enabled && hasAudio) {
      const level = measureAudioLevel(existingPath);
      if (level.isSilent) {
        // Clip was baked with old (too-quiet) settings — re-record it
        // instead of aborting the whole run.
        this.logger.warn(
          `Existing clip "${clipName}" audio too quiet (peak ${level.peakDb.toFixed(1)} dB); ` +
            `re-recording with current sfx settings.`
        );
        fs.unlinkSync(existingPath);
        return null;
      }
    }

    this.logger.debug(`Pickup: using existing clip ${clipName}.mp4`);
    const durationSeconds = await getVideoDuration(existingPath);
    const window = topicWindow(topic, durationSeconds);
    const timing = this.readClipTimingJson(clipsDir, clipName);
    const recorded: RecordedSegment = {
      topic,
      action: actionType,
      filePath: existingPath,
      durationSeconds,
      startTime: window.startTime,
      endTime: window.endTime,
      zoomKeyframes: timing?.zoomKeyframes,
      sfxBaked: timing?.sfxBaked ?? hasAudio,
    };

    // Keep the timing JSON from the original recording — it has the real
    // SFX/zoom data; only write a stub when none exists.
    if (!timing) {
      await this.writeClipTimingJson(existingPath, clipName, {
        moduleDurationSeconds: durationSeconds,
        videoOffsetSeconds: 0,
        sfxEvents: [],
        zoomKeyframes: [],
        sfxBaked: hasAudio,
        pickedUp: true,
      });
    }
    this.emit_event({ type: 'recording-skip', segment: recorded });
    return recorded;
  }

  /**
   * Record one module action into a clip.
   *
   * Module event times are relative to the module's start, while the video
   * starts when recording did; both are shifted by the measured gap so SFX
   * and zoom land on the right frames. SFX are then baked into the clip and
   * a timing JSON is written next to it.
   */
  private async recordClip(
    mod: BrollModule,
    topic: ExtractedTopic,
    actionType: ModuleActionType,
    clipName: string
  ): Promise<RecordedSegment> {
    if (!this.browser.isLaunched) await this.browser.launch();

    this.emit_event({ type: 'recording-start', topic, action: actionType });

    // Open the clip on the search page instead of whatever the last clip left on screen
    await this.browser.prepareForClip();
    await this.recorder.startRecording(this.browser.page, clipName);
    let result: Awaited<ReturnType<BrollModule['execute']>>;
    try {
      result = await mod.execute(this.browser.page, this.browser, topic);
    } catch (err) {
      await this.recorder.abortRecording();
      throw err;
    }
    const filePath = await this.recorder.stopRecording(clipName);

    const videoOffsetSeconds = Math.max(
      0,
      (this.browser.clipStartTime - this.recorder.recordingStartTime) / 1000
    );
    const sfxEvents: SfxEvent[] = (result.sfxEvents ?? []).map((e) => ({
      ...e,
      timeOffset: e.timeOffset + videoOffsetSeconds,
    }));
    const zoomKeyframes: ZoomKeyframe[] = (result.zoomKeyframes ?? []).map((k) => ({
      ...k,
      timeOffset: k.timeOffset + videoOffsetSeconds,
    }));
    const durationSeconds = await getVideoDuration(filePath).catch(
      () => videoOffsetSeconds + result.durationSeconds
    );

    let sfxBaked = false;
    if (sfxEvents.length > 0 && this.config.sfx?.enabled) {
      // Bake SFX into clip for debugging and progressive assembly
      try {
        await this.assembler.bakeSfxIntoClip(filePath, sfxEvents);
        sfxBaked = true;
      } catch (err) {
        this.logger.warn(`Could not bake SFX into clip: ${err}`);
      }

      // Verify clip has audio content when SFX was expected
      if (fs.statSync(filePath).size > 0) {
        const hasAudio = await hasAudioStream(filePath);
        if (!hasAudio) {
          throw new Error(
            `Clip "${clipName}" has no audio track after SFX bake. ` +
              `Expected typing/click sounds. Check FFmpeg and sfx-library.`
          );
        }
        const level = measureAudioLevel(filePath);
        if (level.isSilent) {
          throw new Error(
            `Clip "${clipName}" audio track too quiet (peak ${level.peakDb.toFixed(1)} dB, need >= -45 dB). ` +
              `Raise sfx.volume in config, check sfx-library, or delete clip to re-bake with new settings.`
          );
        }
      }
    }

    const window = topicWindow(topic, durationSeconds);
    const recorded: RecordedSegment = {
      topic,
      action: actionType,
      filePath,
      durationSeconds,
      startTime: window.startTime,
      endTime: window.endTime,
      zoomKeyframes,
      sfxEvents,
      sfxBaked,
    };

    // Write clip timing JSON for debugging sync issues (and zoom on pickup)
    await this.writeClipTimingJson(filePath, clipName, {
      moduleDurationSeconds: result.durationSeconds,
      videoOffsetSeconds,
      sfxEvents,
      zoomKeyframes,
      sfxBaked,
      pickedUp: false,
    });

    this.logger.info(
      `Clip "${clipName}": ${durationSeconds.toFixed(1)}s, ` +
        `${sfxEvents.length} SFX events, ${zoomKeyframes.length} zoom keyframes, ` +
        `module started at +${videoOffsetSeconds.toFixed(2)}s`
    );
    this.emit_event({ type: 'recording-complete', segment: recorded });
    return recorded;
  }

  private async runAnalyzerAndCache(
    segments: { startTime: number; endTime: number; text: string }[],
    cachePath: string,
    transcriptMtime: number
  ): Promise<ExtractedTopic[]> {
    const topics = await this.analyzer.analyze(segments);
    this.emit_event({ type: 'analysis-complete', topics });
    try {
      fs.writeFileSync(
        cachePath,
        JSON.stringify(
          {
            transcriptPath: this.config.transcriptPath,
            transcriptMtime,
            topics,
          },
          null,
          2
        ),
        'utf-8'
      );
      this.logger.debug(`Wrote topics cache: ${cachePath}`);
    } catch (e) {
      this.logger.debug(`Failed to write topics cache: ${e}`);
    }
    return topics;
  }

  /**
   * Write a clip timing JSON file alongside each clip for debugging sync
   * issues. All times are on the clip's video timeline. Zoom keyframes are
   * stored in full so a later run that reuses the clip can still apply them.
   */
  private async writeClipTimingJson(
    filePath: string,
    clipName: string,
    timing: {
      moduleDurationSeconds: number;
      videoOffsetSeconds: number;
      sfxEvents: SfxEvent[];
      zoomKeyframes: ZoomKeyframe[];
      sfxBaked: boolean;
      pickedUp: boolean;
    }
  ): Promise<void> {
    try {
      const videoDuration = await getVideoDuration(filePath).catch(() => timing.moduleDurationSeconds);
      const jsonPath = path.resolve(path.dirname(filePath), `${clipName}.json`);
      const payload: ClipTimingJson = {
        clipName,
        clipPath: filePath,
        videoDuration,
        moduleDurationSeconds: timing.moduleDurationSeconds,
        videoOffsetSeconds: timing.videoOffsetSeconds,
        sfxBaked: timing.sfxBaked,
        pickedUpFromPreviousRun: timing.pickedUp,
        timingNotes: timing.pickedUp
          ? [
              'Clip was picked up from previous run (not re-recorded). No SFX/zoom timing data available.',
              'Delete the clip and re-run to record fresh and get full timing data.',
            ]
          : [
              'Video time 0 = recording start; the module started videoOffsetSeconds later.',
              'All timeOffset values below are already on the video timeline.',
            ],
        sfxEvents: timing.sfxEvents.map((e) => ({
          type: e.type,
          timeOffset: e.timeOffset,
          audioFile: path.basename(e.audioFile),
          durationSeconds: e.durationSeconds,
        })),
        zoomKeyframes: timing.zoomKeyframes,
      };
      const jsonStr = JSON.stringify(payload, null, 2);
      fs.writeFileSync(jsonPath, jsonStr, 'utf-8');
      this.logger.info(`Wrote clip timing: ${jsonPath}`);
      this.logger.debug(`Clip timing JSON:\n${jsonStr}`);
    } catch (err) {
      this.logger.warn(`Could not write clip timing JSON: ${(err as Error).message}`);
    }
  }

  /** Read a clip's timing JSON, keeping only the parts a reused clip needs. */
  private readClipTimingJson(
    clipsDir: string,
    clipName: string
  ): { zoomKeyframes: ZoomKeyframe[]; sfxBaked?: boolean } | null {
    const jsonPath = path.join(clipsDir, `${clipName}.json`);
    if (!fs.existsSync(jsonPath)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as Partial<ClipTimingJson>;
      // Files from older versions stored keyframes without regions — unusable for zoom
      const zoomKeyframes = (raw.zoomKeyframes ?? []).filter(
        (k) => typeof k?.timeOffset === 'number' && k.region != null
      );
      return {
        zoomKeyframes,
        sfxBaked: typeof raw.sfxBaked === 'boolean' ? raw.sfxBaked : undefined,
      };
    } catch (err) {
      this.logger.warn(`Could not read clip timing JSON ${jsonPath}: ${(err as Error).message}`);
      return null;
    }
  }

  private sanitizeFilename(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 100);
  }
}

/** Shape of the `<clip>.json` file written next to each clip. */
interface ClipTimingJson {
  clipName: string;
  clipPath: string;
  videoDuration: number;
  moduleDurationSeconds: number;
  videoOffsetSeconds: number;
  sfxBaked: boolean;
  pickedUpFromPreviousRun: boolean;
  timingNotes: string[];
  sfxEvents: Array<{ type: SfxEvent['type']; timeOffset: number; audioFile: string; durationSeconds: number }>;
  zoomKeyframes: ZoomKeyframe[];
}

/** Segments further apart than this belong to separate mentions of a topic. */
const TOPIC_MENTION_GAP_SECONDS = 20;

/**
 * The transcript window a topic's B-roll should cover: its first stretch of
 * closely spaced segments. The LLM lists segment indices in no guaranteed
 * order and a topic can come up again much later; spanning every mention
 * would claim most of the voiceover and crowd out the topics in between.
 */
export function topicWindow(
  topic: ExtractedTopic,
  fallbackDurationSeconds: number
): { startTime: number; endTime: number } {
  const sorted = [...topic.segments].sort((a, b) => a.startTime - b.startTime);
  if (sorted.length === 0) return { startTime: 0, endTime: fallbackDurationSeconds };

  const startTime = sorted[0].startTime;
  let endTime = sorted[0].endTime;
  for (const seg of sorted.slice(1) as TranscriptSegment[]) {
    if (seg.startTime - endTime > TOPIC_MENTION_GAP_SECONDS) break;
    endTime = Math.max(endTime, seg.endTime);
  }
  return { startTime, endTime };
}
