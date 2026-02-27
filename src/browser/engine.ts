import puppeteer, { Browser, Page } from 'puppeteer-core';
import { PipelineConfig, SfxEvent, ZoomKeyframe } from '../core/types';
import { MouseAnimator } from './mouse';
import { TypingAnimator } from './typing-animator';
import { SfxManager } from '../sfx/manager';
import { Logger } from '../utils/logger';
import { humanDelay } from '../utils/timing';

/**
 * Browser engine wrapping Puppeteer with realistic interaction helpers.
 *
 * Provides high-level methods for searching, navigating, scrolling,
 * and typing — all with human-like timing and mouse animation.
 */
export class BrowserEngine {
  private browser: Browser | null = null;
  private _page: Page | null = null;
  private _mouse: MouseAnimator | null = null;
  private _typingAnimator: TypingAnimator | null = null;
  private sfxManager: SfxManager | null = null;
  private config: PipelineConfig;
  private logger: Logger;

  /** Accumulated SFX events during the current recording clip. */
  private _clipSfxEvents: SfxEvent[] = [];
  /** Time tracking for SFX offset calculations. */
  private _clipStartTime: number = 0;

  constructor(config: PipelineConfig, logger: Logger, sfxManager?: SfxManager) {
    this.config = config;
    this.logger = logger;
    this.sfxManager = sfxManager ?? null;
  }

  get page(): Page {
    if (!this._page) throw new Error('Browser not launched. Call launch() first.');
    return this._page;
  }

  get mouse(): MouseAnimator {
    if (!this._mouse) throw new Error('Browser not launched. Call launch() first.');
    return this._mouse;
  }

  get typingAnimator(): TypingAnimator | null {
    return this._typingAnimator;
  }

  /** Start tracking SFX events for a new recording clip. */
  startClipSfxTracking(): void {
    this._clipSfxEvents = [];
    this._clipStartTime = Date.now();
  }

  /** Get the current time offset into the clip, in seconds. */
  getClipTimeOffset(): number {
    return (Date.now() - this._clipStartTime) / 1000;
  }

  /** Collect all SFX events accumulated during the current clip. */
  collectClipSfxEvents(): SfxEvent[] {
    return [...this._clipSfxEvents];
  }

  async launch(): Promise<void> {
    this.logger.info('Launching browser...');
    const executablePath = this.config.browserExecutablePath
      ?? process.env.CHROME_PATH
      ?? '/usr/bin/google-chrome';

    this.browser = await puppeteer.launch({
      executablePath,
      headless: false,  // Must be visible for screen recording
      defaultViewport: null,
      args: [
        `--window-size=${this.config.viewport.width},${this.config.viewport.height}`,
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    const pages = await this.browser.pages();
    this._page = pages[0] || await this.browser.newPage();

    await this._page.setViewport({
      width: this.config.viewport.width,
      height: this.config.viewport.height,
    });

    // Reduce automation fingerprinting
    await this._page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    this._mouse = new MouseAnimator(this._page);

    // Create typing animator if config is provided
    if (this.config.typing) {
      this._typingAnimator = new TypingAnimator(
        this.config.typing,
        this.logger,
        this.sfxManager ?? undefined
      );
    }

    this.logger.info('Browser launched.');
  }

  /** Navigate to a URL and wait for load. */
  async navigate(url: string): Promise<void> {
    this.logger.info(`Navigating to ${url}`);
    await this.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await humanDelay(500, 1000);
  }

  /** Type text into the currently focused element with human-like keystroke timing. */
  async humanType(text: string, options?: { minDelay?: number; maxDelay?: number }): Promise<void> {
    // Use the advanced typing animator if available
    if (this._typingAnimator) {
      const result = await this._typingAnimator.type(
        this.page,
        text,
        this.getClipTimeOffset() * 1000
      );
      this._clipSfxEvents.push(...result.sfxEvents);
      return;
    }

    // Fallback: simple typing with random delay
    const { minDelay = 50, maxDelay = 150 } = options ?? {};
    for (const char of text) {
      await this.page.keyboard.type(char, {
        delay: minDelay + Math.random() * (maxDelay - minDelay),
      });
    }
  }

  /** Get the search URL for the configured search engine. */
  getSearchUrl(query: string): string {
    const encoded = encodeURIComponent(query);
    switch (this.config.searchEngine) {
      case 'brave':
        return `https://search.brave.com/search?q=${encoded}`;
      case 'duckduckgo':
        return `https://duckduckgo.com/?q=${encoded}`;
      case 'google':
      default:
        return `https://www.google.com/search?q=${encoded}`;
    }
  }

  /** Perform a search by navigating to the search engine, clicking the search box, and typing. */
  async performSearch(query: string): Promise<void> {
    const searchUrl = this.getSearchUrl('');
    await this.navigate(searchUrl);

    // Find and click search input
    const searchSelectors = [
      'input[name="q"]',            // Google & DuckDuckGo
      'textarea[name="q"]',         // Google (sometimes uses textarea)
      'input[name="query"]',        // Some engines
      'input[type="search"]',       // Generic
      '#search-input',              // Brave
    ];

    let clicked = false;
    for (const selector of searchSelectors) {
      try {
        const el = await this.page.$(selector);
        if (el) {
          const box = await el.boundingBox();
          if (box) {
            await this.mouse.moveAndClick(
              box.x + box.width / 2,
              box.y + box.height / 2
            );
            clicked = true;
            break;
          }
        }
      } catch {
        // Try next selector
      }
    }

    if (!clicked) {
      // Fallback: click center-top of page
      await this.mouse.moveAndClick(
        this.config.viewport.width / 2,
        200
      );
    }

    await humanDelay(300, 600);

    // Explicitly focus the search input before typing — keyboard.type() sends to
    // the focused element; a click alone may not establish focus on Google, etc.
    let focused = false;
    for (const selector of searchSelectors) {
      try {
        await this.page.focus(selector);
        focused = true;
        break;
      } catch {
        // Try next selector
      }
    }
    if (!focused) {
      this.logger.warn('Could not focus search input; typing may not appear.');
    }

    await this.humanType(query);
    await humanDelay(200, 400);
    await this.page.keyboard.press('Enter');
    await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await humanDelay(1000, 2000);
  }

  /** Click an element by selector with mouse animation. */
  async clickElement(selector: string): Promise<boolean> {
    try {
      const el = await this.page.$(selector);
      if (!el) return false;

      const box = await el.boundingBox();
      if (!box) return false;

      await this.mouse.moveAndClick(
        box.x + box.width / 2,
        box.y + box.height / 2
      );

      // Record click SFX
      if (this.sfxManager) {
        const clickSfx = this.sfxManager.getClickSfx(this.getClipTimeOffset());
        if (clickSfx) this._clipSfxEvents.push(clickSfx);
      }

      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      this.logger.info('Closing browser.');
      await this.browser.close();
      this.browser = null;
      this._page = null;
      this._mouse = null;
    }
  }
}
