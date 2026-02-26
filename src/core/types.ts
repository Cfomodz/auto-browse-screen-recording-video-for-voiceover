/**
 * Core type definitions for the auto-broll pipeline.
 */

/** A single timestamped segment from the voiceover transcript. */
export interface TranscriptSegment {
  startTime: number;   // seconds
  endTime: number;     // seconds
  text: string;
}

/** A topic/concept extracted from the transcript by the LLM. */
export interface ExtractedTopic {
  topic: string;
  description: string;
  /** Which transcript segments this topic spans. */
  segments: TranscriptSegment[];
  /** Suggested module actions for this topic. */
  suggestedActions: ModuleActionType[];
}

/** The types of browser actions modules can perform. */
export type ModuleActionType =
  | 'web-search'
  | 'news-search'
  | 'definition-search'
  | 'image-search';

/** Configuration for a single module. */
export interface ModuleConfig {
  enabled: boolean;
  /** Module-specific options. */
  options?: Record<string, unknown>;
}

/** Top-level pipeline configuration. */
export interface PipelineConfig {
  /** Path to the transcript file (SRT, VTT, or plain text with timestamps). */
  transcriptPath: string;
  /** Path to the voiceover audio file. */
  audioPath: string;
  /** Directory for intermediate recordings and final output. */
  outputDir: string;
  /** Browser viewport dimensions. */
  viewport: { width: number; height: number };
  /** Path to Chrome/Chromium executable (required for puppeteer-core). */
  browserExecutablePath?: string;
  /** Which search engine to use. */
  searchEngine: 'google' | 'brave' | 'duckduckgo';
  /** LLM provider config for transcript analysis. */
  llm: {
    provider: 'deepseek' | 'openai';
    apiKey: string;
    model?: string;
  };
  /** Per-module configuration. */
  modules: Record<ModuleActionType, ModuleConfig>;
  /** Mouse animation style. */
  mouseStyle: 'realistic' | 'smooth' | 'instant';
  /** Output video settings. */
  video: {
    fps: number;
    resolution: { width: number; height: number };
    format: 'mp4' | 'webm';
  };
}

/** A recorded screen segment tied to a topic. */
export interface RecordedSegment {
  topic: ExtractedTopic;
  action: ModuleActionType;
  filePath: string;       // path to the recorded video clip
  durationSeconds: number;
  /** The transcript time window this clip should cover. */
  startTime: number;
  endTime: number;
}

/** Result of the full pipeline run. */
export interface PipelineResult {
  outputPath: string;
  segments: RecordedSegment[];
  durationSeconds: number;
}

/** Events emitted during pipeline execution. */
export type PipelineEvent =
  | { type: 'analysis-start' }
  | { type: 'analysis-complete'; topics: ExtractedTopic[] }
  | { type: 'recording-start'; topic: ExtractedTopic; action: ModuleActionType }
  | { type: 'recording-complete'; segment: RecordedSegment }
  | { type: 'assembly-start' }
  | { type: 'assembly-complete'; outputPath: string }
  | { type: 'error'; message: string; error?: Error };
