import puppeteer, { Browser, Page } from 'puppeteer-core';
import { PipelineConfig, SfxEvent, ZoomKeyframe, ClickButtonType, CursorEvent } from '../core/types';
import { MouseAnimator } from './mouse';
import { TypingAnimator } from './typing-animator';
import { CursorRenderer, resolveCursorConfig } from './cursor-renderer';
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
  private _cursorRenderer: CursorRenderer | null = null;
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

  get cursorRenderer(): CursorRenderer | null {
    return this._cursorRenderer;
  }

  /** Start tracking SFX and cursor events for a new recording clip. */
  startClipSfxTracking(): void {
    this._clipSfxEvents = [];
    this._clipStartTime = Date.now();
    if (this._cursorRenderer) {
      this._cursorRenderer.startClipTracking(this._clipStartTime);
    }
  }

  /** Get the current time offset into the clip, in seconds. */
  getClipTimeOffset(): number {
    return (Date.now() - this._clipStartTime) / 1000;
  }

  /** Collect all SFX events accumulated during the current clip. */
  collectClipSfxEvents(): SfxEvent[] {
    return [...this._clipSfxEvents];
  }

  /** Collect all cursor events accumulated during the current clip. */
  collectClipCursorEvents(): CursorEvent[] {
    return this._cursorRenderer?.collectEvents() ?? [];
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
        ...(process.env.BROLL_NO_SANDBOX ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
        ...(process.env.BROLL_PROXY ? [`--proxy-server=${process.env.BROLL_PROXY}`, '--ignore-certificate-errors'] : []),
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

    // Create cursor renderer for synthetic cursor overlay
    const cursorConfig = resolveCursorConfig(this.config.cursor);
    if (cursorConfig.enabled) {
      this._cursorRenderer = new CursorRenderer(cursorConfig, this.logger);
      await this._cursorRenderer.inject(this._page);

      // Every main-frame navigation recreates the overlay at (0,0) — restore
      // it to the last known position. Covers Enter-key form submissions,
      // link clicks, and redirects, not just explicit navigate() calls.
      this._page.on('framenavigated', (frame) => {
        if (!this._page || frame !== this._page.mainFrame() || !this._cursorRenderer) return;
        this._cursorRenderer.ensureOnPage(this._page).catch(() => {
          // Execution context may be mid-navigation; the next move corrects it.
        });
      });
    }

    this._mouse = new MouseAnimator(this._page, this._cursorRenderer ?? undefined);

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
    // Re-ensure synthetic cursor overlay after page navigation
    if (this._cursorRenderer) {
      await this._cursorRenderer.ensureOnPage(this.page);
    }
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
    if (process.env.BROLL_SEARCH_URL_OVERRIDE) {
      return `${process.env.BROLL_SEARCH_URL_OVERRIDE}?q=${encoded}`;
    }
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
    // The results page recreated the cursor overlay — restore its position
    if (this._cursorRenderer) {
      await this._cursorRenderer.ensureOnPage(this.page).catch(() => {});
    }
    await humanDelay(1000, 2000);
  }

  /**
   * Move to (x, y) and click, recording the appropriate SFX event.
   *
   * Prefer this over calling browser.mouse.moveAndClick() directly from
   * modules so that click sounds are always tracked.
   */
  async clickAt(
    x: number,
    y: number,
    clickType: ClickButtonType = 'left',
    options?: { durationMs?: number }
  ): Promise<void> {
    await this.mouse.moveAndClick(x, y, options);
    if (this.sfxManager) {
      const sfx = this.sfxManager.getClickSfx(this.getClipTimeOffset(), clickType);
      if (sfx) this._clipSfxEvents.push(sfx);
    }
    // Note: cursor click effects (scaling + ripple) are triggered inside
    // MouseAnimator.moveAndClick() which has direct access to the CursorRenderer.
  }

  /** Click an element by selector with mouse animation. */
  async clickElement(selector: string, clickType: ClickButtonType = 'left'): Promise<boolean> {
    try {
      const el = await this.page.$(selector);
      if (!el) return false;

      const box = await el.boundingBox();
      if (!box) return false;

      await this.clickAt(box.x + box.width / 2, box.y + box.height / 2, clickType);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Scroll the page with SFX audio-cadence when a matching scroll clip exists,
   * otherwise fall back to smooth synthetic scrolling.
   *
   * @param pixels     Total pixels to scroll (positive = down, negative = up)
   * @param durationMs Fallback duration when no scroll clip is available
   */
  async smoothScroll(pixels: number, durationMs: number = 2000): Promise<void> {
    const direction = pixels >= 0 ? 'down' as const : 'up' as const;

    if (this.sfxManager) {
      const result = this.sfxManager.getScrollSfx(Math.abs(pixels), direction, this.getClipTimeOffset());
      if (result) {
        this._clipSfxEvents.push(result.event);
        // Reverse the clip events when scrolling in the opposite direction of the recording
        const reverseDirection = result.clip.direction !== direction;
        await this.mouse.scrollWithAudioCadence(result.clip.events, reverseDirection);
        return;
      }
    }

    await this.mouse.smoothScroll(pixels, durationMs);
  }

  async close(): Promise<void> {
    if (this.browser) {
      this.logger.info('Closing browser.');
      await this.browser.close();
      this.browser = null;
      this._page = null;
      this._mouse = null;
      this._cursorRenderer = null;
    }
  }
}
