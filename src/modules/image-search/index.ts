import { Page } from 'puppeteer-core';
import { BrollModule } from '../../core/module';
import { ExtractedTopic, ModuleActionType, ModuleConfig } from '../../core/types';
import { BrowserEngine } from '../../browser/engine';
import { Logger } from '../../utils/logger';
import { humanDelay } from '../../utils/timing';

/**
 * Image Search module.
 *
 * Searches for a topic, navigates to the Images tab, and slowly
 * scrolls through the image grid — simulating browsing visual
 * content related to the topic.
 */
export class ImageSearchModule extends BrollModule {
  readonly name = 'Image Search';
  readonly actionType: ModuleActionType = 'image-search';

  constructor(config: ModuleConfig, logger: Logger) {
    super(config, logger);
  }

  async execute(page: Page, browser: BrowserEngine, topic: ExtractedTopic): Promise<number> {
    const startTime = Date.now();
    this.logger.info(`Image search: "${topic.topic}"`);

    // Perform initial search
    await browser.performSearch(topic.topic);

    // Click the "Images" tab
    const imagesClicked = await this.clickImagesTab(page, browser);
    if (!imagesClicked) {
      this.logger.warn('Could not find Images tab, continuing with regular results.');
    } else {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
      await humanDelay(1000, 2000);
    }

    // Slowly scroll through the image grid
    for (let i = 0; i < 5; i++) {
      await humanDelay(1500, 2500);
      await browser.mouse.smoothScroll(200 + Math.random() * 150, 2500);
    }

    // Hover over some images for visual interest
    await this.hoverImages(page, browser);

    // Scroll back up a bit
    await browser.mouse.smoothScroll(-200, 1500);
    await humanDelay(500, 1000);

    const durationSec = (Date.now() - startTime) / 1000;
    this.logger.info(`Image search complete (${durationSec.toFixed(1)}s)`);
    return durationSec;
  }

  private async clickImagesTab(page: Page, browser: BrowserEngine): Promise<boolean> {
    const selectors = [
      'a[href*="tbm=isch"]',     // Google Images tab
      'a[href*="udm=2"]',        // Google new Images URL param
      '[role="tab"]:has-text("Images")',
      'a:has-text("Images")',
    ];

    for (const selector of selectors) {
      try {
        const success = await browser.clickElement(selector);
        if (success) return true;
      } catch {
        // Try next
      }
    }

    // Fallback: find link by text
    const links = await page.$$('a');
    for (const link of links) {
      const text = await page.evaluate((el) => el.textContent?.trim(), link);
      if (text === 'Images') {
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

  private async hoverImages(page: Page, browser: BrowserEngine): Promise<void> {
    // Find image thumbnails in the results
    const imageSelectors = [
      'img[data-src]',       // Google image results
      '.rg_i',               // Google image class
      'img.mimg',            // Bing images
      '.tile--img img',      // DuckDuckGo
      'img',                 // Generic fallback
    ];

    let images: Array<{ x: number; y: number; w: number; h: number }> = [];

    for (const selector of imageSelectors) {
      const elements = await page.$$(selector);
      for (const el of elements.slice(0, 20)) {
        const box = await el.boundingBox();
        if (box && box.width > 50 && box.height > 50) {
          images.push({ x: box.x, y: box.y, w: box.width, h: box.height });
        }
      }
      if (images.length > 3) break;
    }

    // Hover over 2-3 random images
    const hoverCount = Math.min(3, images.length);
    const shuffled = images.sort(() => Math.random() - 0.5);

    for (let i = 0; i < hoverCount; i++) {
      const img = shuffled[i];
      await browser.mouse.moveTo(
        img.x + img.w / 2,
        img.y + img.h / 2,
        800 + Math.random() * 400
      );
      await humanDelay(800, 1500);
    }
  }
}
