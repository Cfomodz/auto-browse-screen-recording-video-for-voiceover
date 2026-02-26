import * as fs from 'fs';
import { EventEmitter } from 'events';
import {
  PipelineConfig,
  PipelineEvent,
  PipelineResult,
  RecordedSegment,
  ExtractedTopic,
  ModuleActionType,
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
import { parseTranscript } from '../utils/transcript-parser';
import { createLogger, Logger } from '../utils/logger';

/**
 * Main pipeline orchestrator.
 *
 * Coordinates the full flow:
 *   transcript -> LLM topic extraction -> browser actions + screen recording -> video assembly
 */
export class Pipeline extends EventEmitter {
  private config: PipelineConfig;
  private logger: Logger;
  private registry: ModuleRegistry;
  private browser: BrowserEngine;
  private recorder: ScreenRecorder;
  private analyzer: TranscriptAnalyzer;
  private assembler: VideoAssembler;

  constructor(config: PipelineConfig) {
    super();
    this.config = config;
    this.logger = createLogger('Pipeline');

    // Initialize browser engine
    this.browser = new BrowserEngine(config, createLogger('Browser'));

    // Initialize recorder
    this.recorder = new ScreenRecorder(config, createLogger('Recorder'));

    // Initialize LLM analyzer
    this.analyzer = new TranscriptAnalyzer(config, createLogger('Analyzer'));

    // Initialize video assembler
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

  async run(): Promise<PipelineResult> {
    fs.mkdirSync(this.config.outputDir, { recursive: true });

    // Step 1: Parse transcript
    this.logger.info(`Parsing transcript: ${this.config.transcriptPath}`);
    const segments = parseTranscript(this.config.transcriptPath);
    this.logger.info(`Parsed ${segments.length} transcript segments.`);

    // Step 2: Analyze transcript for topics
    this.emit_event({ type: 'analysis-start' });
    const topics = await this.analyzer.analyze(segments);
    this.emit_event({ type: 'analysis-complete', topics });

    // Step 3: Launch browser
    await this.browser.launch();

    // Step 4: For each topic, run enabled module actions with screen recording
    const recordedSegments: RecordedSegment[] = [];

    try {
      for (const topic of topics) {
        for (const actionType of topic.suggestedActions) {
          const mod = this.registry.get(actionType);
          if (!mod || !mod.enabled) continue;

          const clipName = this.sanitizeFilename(
            `${topic.topic}_${actionType}_${Date.now()}`
          );

          this.emit_event({ type: 'recording-start', topic, action: actionType });

          // Start recording
          await this.recorder.startRecording(this.browser.page, clipName);

          // Execute the module's browser action
          const durationSeconds = await mod.execute(
            this.browser.page,
            this.browser,
            topic
          );

          // Stop recording and get the clip path
          const filePath = await this.recorder.stopRecording(clipName);

          // Determine which time window this clip maps to
          const segStart = topic.segments[0]?.startTime ?? 0;
          const segEnd = topic.segments[topic.segments.length - 1]?.endTime ?? durationSeconds;

          const recorded: RecordedSegment = {
            topic,
            action: actionType,
            filePath,
            durationSeconds,
            startTime: segStart,
            endTime: segEnd,
          };

          recordedSegments.push(recorded);
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

  private sanitizeFilename(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 100);
  }
}
