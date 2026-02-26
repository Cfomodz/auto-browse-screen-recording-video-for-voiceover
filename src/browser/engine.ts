import puppeteer, { Browser, Page } from 'puppeteer-core';
import { PipelineConfig } from '../core/types';
import { MouseAnimator } from './mouse';
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
  private config: PipelineConfig;
  private logger: Logger;

  constructor(config: PipelineConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  get page(): Page {
    if (!this._page) throw new Error('Browser not launched. Call launch() first.');
    return this._page;
  }

  get mouse(): MouseAnimator {
    if (!this._mouse) throw new Error('Browser not launched. Call launch() first.');
    return this._mouse;
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
