import { Page } from 'puppeteer-core';
import { ExtractedTopic, ModuleActionType, ModuleConfig, ZoomKeyframe, SfxEvent } from './types';
import { BrowserEngine } from '../browser/engine';
import { Logger } from '../utils/logger';

/**
 * Result returned by a module's execute() method.
 */
export interface ModuleExecuteResult {
  /** How long the browser action took, in seconds. */
  durationSeconds: number;
  /** Zoom keyframes describing the camera journey during this action. */
  zoomKeyframes: ZoomKeyframe[];
  /** SFX events collected during this action. */
  sfxEvents: SfxEvent[];
}

/**
 * Base class for all B-roll action modules.
 *
 * Each module encapsulates a specific browser-based action (searching,
 * scrolling news, looking up definitions, browsing images, etc.).
 * Modules are enabled/disabled via pipeline config and are driven by
 * extracted topics from the transcript.
 */
export abstract class BrollModule {
  abstract readonly name: string;
  abstract readonly actionType: ModuleActionType;

  protected config: ModuleConfig;
  protected logger: Logger;

  constructor(config: ModuleConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Execute this module's browser action for a given topic.
   * The module drives the browser page with realistic interactions
   * while the screen recorder captures everything.
   *
   * @param page      - Puppeteer page to operate on
   * @param browser   - Browser engine for mouse animation helpers
   * @param topic     - The topic/concept to act on
   * @returns Execution result with duration, zoom keyframes, and SFX events
   */
  abstract execute(
    page: Page,
    browser: BrowserEngine,
    topic: ExtractedTopic
  ): Promise<ModuleExecuteResult>;
}

/**
 * Registry that holds all available modules and resolves them by action type.
 */
export class ModuleRegistry {
  private modules: Map<ModuleActionType, BrollModule> = new Map();

  register(mod: BrollModule): void {
    this.modules.set(mod.actionType, mod);
  }

  get(actionType: ModuleActionType): BrollModule | undefined {
    return this.modules.get(actionType);
  }

  getEnabled(): BrollModule[] {
    return [...this.modules.values()].filter((m) => m.enabled);
  }

  all(): BrollModule[] {
    return [...this.modules.values()];
  }
}
