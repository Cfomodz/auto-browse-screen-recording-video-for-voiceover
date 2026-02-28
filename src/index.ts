// Public API exports
export { Pipeline } from './core/pipeline';
export { BrollModule, ModuleRegistry } from './core/module';
export type { ModuleExecuteResult } from './core/module';
export { BrowserEngine } from './browser/engine';
export { MouseAnimator } from './browser/mouse';
export { TypingAnimator } from './browser/typing-animator';
export { CursorRenderer, resolveCursorConfig, DEFAULT_CURSOR_CONFIG } from './browser/cursor-renderer';
export { TranscriptAnalyzer } from './modules/transcript-analyzer';
export { ScreenRecorder } from './modules/screen-recorder';
export { VideoAssembler } from './modules/video-assembler';
export { WebSearchModule } from './modules/web-search';
export { NewsSearchModule } from './modules/news-search';
export { DefinitionSearchModule } from './modules/definition-search';
export { ImageSearchModule } from './modules/image-search';
export { SfxManager } from './sfx/manager';
export { ZoomEngine, ZoomPresets } from './camera/zoom-engine';
export { KeystrokeRecorder } from './keystroke-recorder/recorder';
export { CoverageAnalyzer } from './keystroke-recorder/coverage';
export type { TypingPattern, CoverageReport } from './keystroke-recorder/coverage';
export { parseTranscript } from './utils/transcript-parser';
export { createLogger } from './utils/logger';

export type {
  PipelineConfig,
  PipelineResult,
  PipelineEvent,
  TranscriptSegment,
  ExtractedTopic,
  RecordedSegment,
  ModuleActionType,
  ModuleConfig,
  SfxConfig,
  SfxEvent,
  CameraConfig,
  ZoomKeyframe,
  TypingConfig,
  TypingClipMeta,
  KeystrokeEvent,
  CursorConfig,
  CursorEvent,
} from './core/types';
