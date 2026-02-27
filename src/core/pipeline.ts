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
} from './types';
import { ModuleRegistry } from './module';
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
import { getVideoDuration } from '../utils/video';
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

    // Step 3: Launch browser
    await this.browser.launch();

    // Step 4: For each topic, run enabled module actions with screen recording (or use existing clip)
    const recordedSegments: RecordedSegment[] = [];

    try {
      for (const topic of topics) {
        for (const actionType of topic.suggestedActions) {
          const mod = this.registry.get(actionType);
          if (!mod || !mod.enabled) continue;

          const clipName = this.sanitizeFilename(`${topic.topic}_${actionType}`);
          const existingPath = path.join(clipsDir, `${clipName}.mp4`);

          if (fs.existsSync(existingPath)) {
            const stat = fs.statSync(existingPath);
            if (stat.size > 0) {
              this.logger.debug(`Pickup: using existing clip ${clipName}.mp4`);
              const durationSeconds = await getVideoDuration(existingPath);
              const segStart = topic.segments[0]?.startTime ?? 0;
              const segEnd = topic.segments[topic.segments.length - 1]?.endTime ?? segStart + durationSeconds;
              const recorded: RecordedSegment = {
                topic,
                action: actionType,
                filePath: existingPath,
                durationSeconds,
                startTime: segStart,
                endTime: segEnd,
              };
              recordedSegments.push(recorded);
              this.emit_event({ type: 'recording-skip', segment: recorded });
              continue;
            }
          }

          this.emit_event({ type: 'recording-start', topic, action: actionType });
          await this.recorder.startRecording(this.browser.page, clipName);

          const result = await mod.execute(
            this.browser.page,
            this.browser,
            topic
          );

          const filePath = await this.recorder.stopRecording(clipName);
          const segStart = topic.segments[0]?.startTime ?? 0;
          const segEnd = topic.segments[topic.segments.length - 1]?.endTime ?? result.durationSeconds;

          const recorded: RecordedSegment = {
            topic,
            action: actionType,
            filePath,
            durationSeconds: result.durationSeconds,
            startTime: segStart,
            endTime: segEnd,
            zoomKeyframes: result.zoomKeyframes,
            sfxEvents: result.sfxEvents,
          };

          recordedSegments.push(recorded);
          this.logger.info(
            `Clip "${clipName}": ${result.durationSeconds.toFixed(1)}s, ` +
            `${(result.sfxEvents ?? []).length} SFX events, ` +
            `${(result.zoomKeyframes ?? []).length} zoom keyframes`
          );
          this.emit_event({ type: 'recording-complete', segment: recorded });
        }
      }
    } finally {
      await this.browser.close();
    }

    // Step 5: Assemble final video
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
          return raw.topics as ExtractedTopic[];
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
    const existingPath = path.join(clipsDir, `${clipName}.mp4`);
    if (fs.existsSync(existingPath) && fs.statSync(existingPath).size > 0) {
      this.logger.debug(`Using existing clip: ${existingPath}`);
      const durationSeconds = await getVideoDuration(existingPath);
      const segStart = topic.segments[0]?.startTime ?? 0;
      const segEnd = topic.segments[topic.segments.length - 1]?.endTime ?? segStart + durationSeconds;
      const recorded: RecordedSegment = {
        topic,
        action: actionType,
        filePath: existingPath,
        durationSeconds,
        startTime: segStart,
        endTime: segEnd,
      };
      this.emit_event({ type: 'recording-skip', segment: recorded });
      return recorded;
    }

    await this.browser.launch();
    try {
      this.emit_event({ type: 'recording-start', topic, action: actionType });
      await this.recorder.startRecording(this.browser.page, clipName);
      const result = await mod.execute(this.browser.page, this.browser, topic);
      const filePath = await this.recorder.stopRecording(clipName);
      const segStart = topic.segments[0]?.startTime ?? 0;
      const segEnd = topic.segments[topic.segments.length - 1]?.endTime ?? result.durationSeconds;
      const recorded: RecordedSegment = {
        topic,
        action: actionType,
        filePath,
        durationSeconds: result.durationSeconds,
        startTime: segStart,
        endTime: segEnd,
        zoomKeyframes: result.zoomKeyframes,
        sfxEvents: result.sfxEvents,
      };
      this.emit_event({ type: 'recording-complete', segment: recorded });
      return recorded;
    } finally {
      await this.browser.close();
    }
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

  private sanitizeFilename(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 100);
  }
}
