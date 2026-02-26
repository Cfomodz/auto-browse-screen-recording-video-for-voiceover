import { Page } from 'puppeteer-core';
import { BrollModule, ModuleExecuteResult } from '../../core/module';
import { ExtractedTopic, ModuleActionType, ModuleConfig, ZoomKeyframe } from '../../core/types';
import { BrowserEngine } from '../../browser/engine';
import { ZoomPresets } from '../../camera/zoom-engine';
import { Logger } from '../../utils/logger';
import { humanDelay } from '../../utils/timing';

/**
 * Image Search module.
 *
 * Searches for a topic, navigates to the Images tab, and slowly
 * scrolls through the image grid — simulating browsing visual
 * content related to the topic.
 *
 * Camera journey:
 *   1. Zoom to search bar while typing
 *   2. Zoom out after search
 *   3. Scan to tab bar, zoom to "Images" tab
 *   4. Zoom out to see image grid
 *   5. If clicking an image: zoom to the right panel preview
 *   6. Pull back out
 */
export class ImageSearchModule extends BrollModule {
  readonly name = 'Image Search';
  readonly actionType: ModuleActionType = 'image-search';

  constructor(config: ModuleConfig, logger: Logger) {
    super(config, logger);
  }

  async execute(page: Page, browser: BrowserEngine, topic: ExtractedTopic): Promise<ModuleExecuteResult> {
    const startTime = Date.now();
    const elapsed = () => (Date.now() - startTime) / 1000;
    const zoomKeyframes: ZoomKeyframe[] = [];

    this.logger.info(`Image search: "${topic.topic}"`);
    browser.startClipSfxTracking();

    // Zoom to search bar
    zoomKeyframes.push(ZoomPresets.searchBarFocus(elapsed()));

    // Perform initial search
    await browser.performSearch(topic.topic);

    // Zoom out
    zoomKeyframes.push(ZoomPresets.fullWindow(elapsed()));

    // Zoom to the tab bar to show "Images" navigation
    zoomKeyframes.push(ZoomPresets.tabBarFocus(elapsed()));

    // Click the "Images" tab
    const imagesClicked = await this.clickImagesTab(page, browser);
    if (!imagesClicked) {
      this.logger.warn('Could not find Images tab, continuing with regular results.');
    } else {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
      await humanDelay(1000, 2000);
    }

    // Zoom out to see image grid
    zoomKeyframes.push(ZoomPresets.fullWindow(elapsed()));
    await humanDelay(300, 500);

    // Zoom to image grid area
    zoomKeyframes.push(ZoomPresets.imageGridFocus(elapsed()));

    // Slowly scroll through the image grid
    for (let i = 0; i < 5; i++) {
      await humanDelay(1500, 2500);
      await browser.mouse.smoothScroll(200 + Math.random() * 150, 2500);
    }

    // Hover over some images — zoom to each one briefly
    await this.hoverImages(page, browser, zoomKeyframes, elapsed);

    // Scroll back up a bit, pull back to full
    zoomKeyframes.push(ZoomPresets.fullWindow(elapsed()));
    await browser.mouse.smoothScroll(-200, 1500);
    await humanDelay(500, 1000);

    const durationSeconds = elapsed();
    this.logger.info(`Image search complete (${durationSeconds.toFixed(1)}s)`);

    return {
      durationSeconds,
      zoomKeyframes,
      sfxEvents: browser.collectClipSfxEvents(),
    };
  }

  private async clickImagesTab(page: Page, browser: BrowserEngine): Promise<boolean> {
    const selectors = [
      'a[href*="tbm=isch"]',
      'a[href*="udm=2"]',
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

  private async hoverImages(
    page: Page,
    browser: BrowserEngine,
    zoomKeyframes: ZoomKeyframe[],
    elapsed: () => number
  ): Promise<void> {
    const imageSelectors = [
      'img[data-src]',
      '.rg_i',
      'img.mimg',
      '.tile--img img',
      'img',
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

    const vw = page.viewport()?.width ?? 1920;
    const vh = page.viewport()?.height ?? 1080;

    const hoverCount = Math.min(3, images.length);
    const shuffled = images.sort(() => Math.random() - 0.5);

    for (let i = 0; i < hoverCount; i++) {
      const img = shuffled[i];

      // Zoom towards the hovered image
      zoomKeyframes.push(
        ZoomPresets.elementFocus(
          elapsed(),
          (img.x + img.w / 2) / vw,
          (img.y + img.h / 2) / vh,
          `hover-image-${i}`
        )
      );

      await browser.mouse.moveTo(
        img.x + img.w / 2,
        img.y + img.h / 2,
        800 + Math.random() * 400
      );
      await humanDelay(800, 1500);
    }
  }
}
