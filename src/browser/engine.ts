import puppeteer, { BoundingBox, Browser, Page } from 'puppeteer-core';
import { PipelineConfig, SfxEvent, ZoomKeyframe, ClickButtonType, CursorEvent } from '../core/types';
import { MouseAnimator } from './mouse';
import { TypingAnimator } from './typing-animator';
import { CursorRenderer, resolveCursorConfig } from './cursor-renderer';
import { SfxManager } from '../sfx/manager';
import { Logger } from '../utils/logger';
import { humanDelay } from '../utils/timing';
import { ZoomPresets } from '../camera/zoom-engine';

/** Thrown when a search engine shows a bot check instead of the page we need. */
export class BotChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BotChallengeError';
  }
}

type PageElement = NonNullable<Awaited<ReturnType<Page['$']>>>;

/** Search input selectors, tried in order; the first visible match wins. */
const SEARCH_INPUT_SELECTORS = [
  'input[name="q"]',            // Bing, DuckDuckGo
  'textarea[name="q"]',         // Google
  'input[name="query"]',        // Some engines
  'input[type="search"]',       // Generic
  '#search-input',              // Brave
];

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
  /** True while the page is the freshly loaded search home from prepareForClip(). */
  private _atSearchHome = false;

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

  get isLaunched(): boolean {
    return this.browser !== null;
  }

  /** Absolute Date.now() when the current clip's module started (startClipSfxTracking). */
  get clipStartTime(): number {
    return this._clipStartTime;
  }

  get viewport(): { width: number; height: number } {
    return this.config.viewport;
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
      // A page frozen by a bot check would otherwise stall every call for 3 minutes
      protocolTimeout: 60000,
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

    await this.fitWindowToViewport(this._page);
    await this._page.setViewport({
      width: this.config.viewport.width,
      height: this.config.viewport.height,
    });

    // Reduce automation fingerprinting
    await this._page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    this._page.on('framenavigated', (frame) => {
      if (frame === this._page?.mainFrame()) this._atSearchHome = false;
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

  /**
   * Get ready for a new clip before recording starts: open the search
   * engine's home page and park the cursor where a hand would rest. Without
   * this, clips open on a blank page or the previous clip's last page, with
   * the cursor stuck in the top-left corner.
   */
  async prepareForClip(): Promise<void> {
    await this.navigate(this.getSearchUrl(''));
    await this.dismissConsentDialog();
    await this.throwIfBotChallenge('opening the search page');

    const { width, height } = this.config.viewport;
    await this.mouse.jumpTo(
      Math.round(width * (0.45 + Math.random() * 0.1)),
      Math.round(height * (0.6 + Math.random() * 0.1))
    );
    this._atSearchHome = true;
  }

  /**
   * Size the browser window so its page area is the configured viewport.
   *
   * The screencast only captures what the window shows. A window of exactly
   * viewport size loses ~140px to the tab strip and address bar, and the
   * bottom of every page is missing from the recording. Grow the window by
   * that overhead; if the OS won't allow a window that big (it may cap it at
   * the screen size), go fullscreen, which has no browser UI at all.
   */
  private async fitWindowToViewport(page: Page): Promise<void> {
    const { width, height } = this.config.viewport;
    const measure = () =>
      page.evaluate(() => {
        const w = globalThis as any;
        return { inner: [w.innerWidth, w.innerHeight], outer: [w.outerWidth, w.outerHeight] };
      });
    const fits = (inner: number[]) => inner[0] >= width && inner[1] >= height;

    try {
      const session = await page.createCDPSession();
      const { windowId } = await session.send('Browser.getWindowForTarget');
      let { inner, outer } = await measure();

      if (!fits(inner)) {
        await session.send('Browser.setWindowBounds', {
          windowId,
          bounds: { width: width + (outer[0] - inner[0]), height: height + (outer[1] - inner[1]) },
        });
        await new Promise((r) => setTimeout(r, 300));
        ({ inner } = await measure());
      }
      if (!fits(inner)) {
        await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
        await new Promise((r) => setTimeout(r, 500));
        ({ inner } = await measure());
      }
      await session.detach();

      if (!fits(inner)) {
        this.logger.warn(
          `The browser can only show ${inner[0]}x${inner[1]} of the ${width}x${height} viewport on this ` +
            `screen, so recordings will be scaled down to fit. Use a smaller "viewport" or a larger display.`
        );
      }
    } catch (err) {
      this.logger.warn(`Could not size the browser window: ${(err as Error).message}`);
    }
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

  /** Get the search URL for the configured search engine (its home page when query is empty). */
  getSearchUrl(query: string): string {
    const encoded = encodeURIComponent(query);
    const override = process.env.BROLL_SEARCH_URL_OVERRIDE;
    if (override) {
      return query ? `${override}?q=${encoded}` : override;
    }
    switch (this.config.searchEngine) {
      case 'brave':
        return query ? `https://search.brave.com/search?q=${encoded}` : 'https://search.brave.com/';
      case 'duckduckgo':
        return query ? `https://duckduckgo.com/?q=${encoded}` : 'https://duckduckgo.com/';
      case 'google':
      default:
        return query ? `https://www.google.com/search?q=${encoded}` : 'https://www.google.com/';
    }
  }

  /** Bounding box of the visible search input on the current page, if any. */
  async locateSearchBox(): Promise<BoundingBox | null> {
    return (await this.findSearchInput())?.box ?? null;
  }

  /** Zoom keyframe framing the search box (falls back to the top-center preset). */
  async searchBoxFocus(timeOffset: number): Promise<ZoomKeyframe> {
    const box = await this.locateSearchBox().catch(() => null);
    return box
      ? ZoomPresets.boxFocus(timeOffset, box, this.config.viewport, 'search-box-focus')
      : ZoomPresets.searchBarFocus(timeOffset);
  }

  /**
   * Elements matching `selector` that are entirely on screen, in document
   * order. Modules pick hover/click targets after scrolling, when the first
   * matches in the document are above the viewport — moving to those sends
   * the cursor off-screen and the click goes nowhere.
   */
  async visibleElements(selector: string): Promise<Array<{ handle: PageElement; box: BoundingBox }>> {
    const { width, height } = this.config.viewport;
    const visible: Array<{ handle: PageElement; box: BoundingBox }> = [];
    for (const handle of await this.page.$$(selector)) {
      const box = await handle.boundingBox().catch(() => null);
      if (
        box && box.width > 0 && box.height > 0 &&
        box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height
      ) {
        visible.push({ handle, box });
      }
    }
    return visible;
  }

  private async findSearchInput(): Promise<{ handle: PageElement; box: BoundingBox } | null> {
    for (const selector of SEARCH_INPUT_SELECTORS) {
      try {
        for (const handle of await this.page.$$(selector)) {
          const box = await handle.boundingBox();
          if (box && box.width > 0 && box.height > 0) return { handle, box };
        }
      } catch {
        // Try next selector
      }
    }
    return null;
  }

  /**
   * Look for a search engine bot check: a CAPTCHA / "unusual traffic" page,
   * a blank page, or a renderer frozen by a challenge script. Returns a
   * description of what was found, or null if the page looks normal.
   */
  async detectBotChallenge(): Promise<string | null> {
    const probe = this.page
      .evaluate(() => {
        const doc = (globalThis as any).document;
        return { url: String(doc.location.href), text: String(doc.body?.innerText ?? '') };
      })
      .catch(() => null);
    const timedOut = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 8000));
    const info = await Promise.race([probe, timedOut]);

    if (info === 'timeout') return 'the page froze (bot-check scripts do this)';
    if (!info) return null; // mid-navigation — nothing to judge yet
    if (/\/sorry\//.test(info.url)) return 'it showed its "unusual traffic" page';

    const text = info.text.trim();
    if (text.length === 0) return 'it showed a blank page';
    if (
      text.length < 1500 &&
      /unusual traffic|one last step|verify you are human|are you a robot|not a robot/i.test(text)
    ) {
      return 'it asked to verify you are human';
    }
    return null;
  }

  private async throwIfBotChallenge(during: string): Promise<void> {
    const challenge = await this.detectBotChallenge();
    if (!challenge) return;
    const url = new URL(this.page.url());
    throw new BotChallengeError(
      `Bot check from ${url.origin}${url.pathname} while ${during}: ${challenge}. ` +
        `Stopping rather than recording it. Clips recorded so far are kept and reused on the ` +
        `next run. Try again later, or switch "searchEngine" in the config.`
    );
  }

  /** Dismiss a cookie-consent interstitial (e.g. Google's in the EU) if one is showing. */
  private async dismissConsentDialog(): Promise<void> {
    const dismissed = await this.page
      .evaluate(() => {
        const labels = /^(reject all|accept all|i agree|alle ablehnen|tout refuser)$/i;
        const doc = (globalThis as any).document;
        const button = [...doc.querySelectorAll('button, [role="button"]')].find((el: any) =>
          labels.test(String(el.textContent ?? '').trim())
        );
        button?.click();
        return Boolean(button);
      })
      .catch(() => false);
    if (dismissed) {
      this.logger.info('Dismissed a cookie-consent dialog.');
      await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
    }
  }

  /** Perform a search: open the search engine (unless already there), click the search box, and type. */
  async performSearch(query: string): Promise<void> {
    if (!this._atSearchHome) {
      await this.navigate(this.getSearchUrl(''));
    }

    const input = await this.findSearchInput();
    if (input) {
      await this.mouse.moveAndClick(
        input.box.x + input.box.width / 2,
        input.box.y + input.box.height / 2
      );
    } else {
      // Fallback: click center-top of page
      this.logger.warn('Search input not found; clicking where it usually is.');
      await this.mouse.moveAndClick(this.config.viewport.width / 2, 200);
    }

    await humanDelay(300, 600);

    // Explicitly focus the search input before typing — keyboard.type() sends to
    // the focused element; a click alone may not establish focus on Google, etc.
    if (input) {
      await input.handle.focus().catch(() => {
        this.logger.warn('Could not focus search input; typing may not appear.');
      });
    }

    await this.humanType(query);
    await humanDelay(200, 400);
    await this.withNavigation(() => this.page.keyboard.press('Enter'));
    await this.throwIfBotChallenge(`searching for "${query}"`);
    // The results page recreated the cursor overlay — restore its position
    if (this._cursorRenderer) {
      await this._cursorRenderer.ensureOnPage(this.page).catch(() => {});
    }
    await humanDelay(1000, 2000);
  }

  /**
   * Run an action that may navigate (a click, Enter in a form) and wait for
   * the navigation it causes. The wait is registered before the action runs:
   * registered after, a fast page can finish loading first, and the wait
   * then sits out its whole timeout on a frozen page. If the action returns
   * false (nothing was clicked), no navigation is awaited.
   *
   * Use waitUntil 'domcontentloaded' for links to other sites: their trackers
   * keep connections open, so 'networkidle2' tends to wait out the timeout.
   */
  async withNavigation<T>(
    action: () => Promise<T>,
    timeoutMs: number = 15000,
    waitUntil: 'domcontentloaded' | 'networkidle2' = 'networkidle2'
  ): Promise<T> {
    const navigation = this.page
      .waitForNavigation({ waitUntil, timeout: timeoutMs })
      .catch(() => null);
    const result = await action();
    if (result !== false) await navigation;
    return result;
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
