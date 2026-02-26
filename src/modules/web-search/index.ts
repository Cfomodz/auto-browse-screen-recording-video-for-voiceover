import { Page } from 'puppeteer-core';
import { BrollModule, ModuleExecuteResult } from '../../core/module';
import { ExtractedTopic, ModuleActionType, ModuleConfig, ZoomKeyframe } from '../../core/types';
import { BrowserEngine } from '../../browser/engine';
import { ZoomPresets } from '../../camera/zoom-engine';
import { Logger } from '../../utils/logger';
import { humanDelay } from '../../utils/timing';

/**
 * Web Search module.
 *
 * Performs a general web search for a topic, slowly scrolls through
 * the results to create natural-looking B-roll of someone researching.
 *
 * Camera journey:
 *   1. Zoom to search bar while typing
 *   2. Zoom out to full window after pressing Enter
 *   3. Zoom to search results (left 2/3) while scrolling
 *   4. Zoom to hovered link
 *   5. Pull back out
 */
export class WebSearchModule extends BrollModule {
  readonly name = 'Web Search';
  readonly actionType: ModuleActionType = 'web-search';

  constructor(config: ModuleConfig, logger: Logger) {
    super(config, logger);
  }

  async execute(page: Page, browser: BrowserEngine, topic: ExtractedTopic): Promise<ModuleExecuteResult> {
    const startTime = Date.now();
    const elapsed = () => (Date.now() - startTime) / 1000;
    const zoomKeyframes: ZoomKeyframe[] = [];

    this.logger.info(`Web search: "${topic.topic}"`);
    browser.startClipSfxTracking();

    // Zoom to search bar as we navigate
    zoomKeyframes.push(ZoomPresets.searchBarFocus(elapsed()));

    // Perform the search (typing happens here)
    await browser.performSearch(topic.topic);

    // Zoom out to see results
    zoomKeyframes.push(ZoomPresets.fullWindow(elapsed()));
    await humanDelay(500, 800);

    // Zoom to results area
    zoomKeyframes.push(ZoomPresets.searchResultsFocus(elapsed()));

    // Slowly scroll through results to simulate reading
    const scrollPasses = 3;
    for (let i = 0; i < scrollPasses; i++) {
      await humanDelay(1500, 2500);
      await browser.mouse.smoothScroll(300 + Math.random() * 200, 2000);
    }

    // Hover over a result link — zoom to it
    const links = await page.$$('h3');
    if (links.length > 0) {
      const targetLink = links[Math.min(1, links.length - 1)];
      const box = await targetLink.boundingBox();
      if (box) {
        const vw = page.viewport()?.width ?? 1920;
        const vh = page.viewport()?.height ?? 1080;
        zoomKeyframes.push(
          ZoomPresets.elementFocus(elapsed(), box.x / vw, box.y / vh, 'hover-result')
        );

        await browser.mouse.moveTo(
          box.x + box.width / 2,
          box.y + box.height / 2,
          800
        );
        await humanDelay(1000, 2000);
      }
    }

    // Pull back out
    zoomKeyframes.push(ZoomPresets.fullWindow(elapsed()));
    await browser.mouse.smoothScroll(-150, 1000);
    await humanDelay(500, 1000);

    const durationSeconds = elapsed();
    this.logger.info(`Web search complete (${durationSeconds.toFixed(1)}s)`);

    return {
      durationSeconds,
      zoomKeyframes,
      sfxEvents: browser.collectClipSfxEvents(),
    };
  }
}
