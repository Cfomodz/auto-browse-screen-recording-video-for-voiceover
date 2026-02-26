import { Page } from 'puppeteer-core';
import { BrollModule, ModuleExecuteResult } from '../../core/module';
import { ExtractedTopic, ModuleActionType, ModuleConfig, ZoomKeyframe } from '../../core/types';
import { BrowserEngine } from '../../browser/engine';
import { ZoomPresets } from '../../camera/zoom-engine';
import { Logger } from '../../utils/logger';
import { humanDelay } from '../../utils/timing';

/**
 * News Search module.
 *
 * Searches for a topic, navigates to the News tab, slowly scrolls
 * through headlines, then clicks on one article — simulating a person
 * browsing news coverage of the topic.
 *
 * Camera journey:
 *   1. Zoom to search bar while typing
 *   2. Zoom out after search
 *   3. Scan across to the tab bar, zoom to "News" tab
 *   4. Zoom out to see news headlines
 *   5. Zoom to results area while scrolling
 *   6. Zoom to clicked article headline
 *   7. Pull back to full window for the article page
 */
export class NewsSearchModule extends BrollModule {
  readonly name = 'News Search';
  readonly actionType: ModuleActionType = 'news-search';

  constructor(config: ModuleConfig, logger: Logger) {
    super(config, logger);
  }

  async execute(page: Page, browser: BrowserEngine, topic: ExtractedTopic): Promise<ModuleExecuteResult> {
    const startTime = Date.now();
    const elapsed = () => (Date.now() - startTime) / 1000;
    const zoomKeyframes: ZoomKeyframe[] = [];

    this.logger.info(`News search: "${topic.topic}"`);
    browser.startClipSfxTracking();

    // Zoom to search bar
    zoomKeyframes.push(ZoomPresets.searchBarFocus(elapsed()));

    // Perform initial search
    await browser.performSearch(topic.topic);

    // Zoom out after search completes
    zoomKeyframes.push(ZoomPresets.fullWindow(elapsed()));

    // Zoom to tab bar to show "News" navigation
    zoomKeyframes.push(ZoomPresets.tabBarFocus(elapsed()));

    // Click the "News" tab
    const newsClicked = await this.clickNewsTab(page, browser);
    if (!newsClicked) {
      this.logger.warn('Could not find News tab, continuing with regular results.');
    } else {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
      await humanDelay(1000, 1500);
    }

    // Zoom out to see news results
    zoomKeyframes.push(ZoomPresets.fullWindow(elapsed()));
    await humanDelay(300, 500);

    // Zoom to results area
    zoomKeyframes.push(ZoomPresets.searchResultsFocus(elapsed()));

    // Slowly scroll through news headlines
    for (let i = 0; i < 4; i++) {
      await humanDelay(1500, 2500);
      await browser.mouse.smoothScroll(250 + Math.random() * 150, 2500);
    }

    // Click on a news headline
    const articleClicked = await this.clickNewsArticle(page, browser);
    if (articleClicked) {
      // Zoom out for the article page
      zoomKeyframes.push(ZoomPresets.fullWindow(elapsed()));
      // Wait for article page to load and pause to "read"
      await humanDelay(2000, 4000);
      // Scroll down the article slowly
      await browser.mouse.smoothScroll(400, 3000);
      await humanDelay(1000, 2000);
    }

    // Final pull-back
    zoomKeyframes.push(ZoomPresets.fullWindow(elapsed()));

    const durationSeconds = elapsed();
    this.logger.info(`News search complete (${durationSeconds.toFixed(1)}s)`);

    return {
      durationSeconds,
      zoomKeyframes,
      sfxEvents: browser.collectClipSfxEvents(),
    };
  }

  private async clickNewsTab(page: Page, browser: BrowserEngine): Promise<boolean> {
    const selectors = [
      'a[href*="tbm=nws"]',
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
