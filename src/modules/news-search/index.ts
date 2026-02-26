import { Page } from 'puppeteer-core';
import { BrollModule } from '../../core/module';
import { ExtractedTopic, ModuleActionType, ModuleConfig } from '../../core/types';
import { BrowserEngine } from '../../browser/engine';
import { Logger } from '../../utils/logger';
import { humanDelay } from '../../utils/timing';

/**
 * News Search module.
 *
 * Searches for a topic, navigates to the News tab, slowly scrolls
 * through headlines, then clicks on one article — simulating a person
 * browsing news coverage of the topic.
 */
export class NewsSearchModule extends BrollModule {
  readonly name = 'News Search';
  readonly actionType: ModuleActionType = 'news-search';

  constructor(config: ModuleConfig, logger: Logger) {
    super(config, logger);
  }

  async execute(page: Page, browser: BrowserEngine, topic: ExtractedTopic): Promise<number> {
    const startTime = Date.now();
    this.logger.info(`News search: "${topic.topic}"`);

    // Perform initial search
    await browser.performSearch(topic.topic);

    // Click the "News" tab
    const newsClicked = await this.clickNewsTab(page, browser);
    if (!newsClicked) {
      this.logger.warn('Could not find News tab, continuing with regular results.');
    } else {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
      await humanDelay(1000, 1500);
    }

    // Slowly scroll through news headlines
    for (let i = 0; i < 4; i++) {
      await humanDelay(1500, 2500);
      await browser.mouse.smoothScroll(250 + Math.random() * 150, 2500);
    }

    // Click on a news headline
    const articleClicked = await this.clickNewsArticle(page, browser);
    if (articleClicked) {
      // Wait for article page to load and pause to "read"
      await humanDelay(2000, 4000);
      // Scroll down the article slowly
      await browser.mouse.smoothScroll(400, 3000);
      await humanDelay(1000, 2000);
    }

    const durationSec = (Date.now() - startTime) / 1000;
    this.logger.info(`News search complete (${durationSec.toFixed(1)}s)`);
    return durationSec;
  }

  private async clickNewsTab(page: Page, browser: BrowserEngine): Promise<boolean> {
    // Try common News tab selectors across search engines
    const selectors = [
      'a[href*="tbm=nws"]',       // Google News tab
      'a[data-hveid][href*="news"]',
      '[role="tab"]:has-text("News")',
      'a:has-text("News")',
    ];

    for (const selector of selectors) {
      try {
        const success = await browser.clickElement(selector);
        if (success) return true;
      } catch {
        // Try next
      }
    }

    // Fallback: find any link with "News" text
    const links = await page.$$('a');
    for (const link of links) {
      const text = await page.evaluate((el) => el.textContent?.trim(), link);
      if (text === 'News') {
        const box = await link.boundingBox();
        if (box) {
          await browser.mouse.moveAndClick(
            box.x + box.width / 2,
            box.y + box.height / 2
          );
          return true;
        }
      }
    }

    return false;
  }

  private async clickNewsArticle(page: Page, browser: BrowserEngine): Promise<boolean> {
    // Find article links — usually h3 elements or specific news result selectors
    const articleSelectors = [
      'div[data-news-doc-id] a',
      'article a',
      'g-card a',
      '.news-results a',
      'h3 a',
    ];

    for (const selector of articleSelectors) {
      const elements = await page.$$(selector);
      if (elements.length > 0) {
        // Pick one of the first few articles
        const target = elements[Math.min(Math.floor(Math.random() * 3), elements.length - 1)];
        const box = await target.boundingBox();
        if (box) {
          await browser.mouse.moveAndClick(
            box.x + box.width / 2,
            box.y + box.height / 2
          );
          return true;
        }
      }
    }

    return false;
  }
}
