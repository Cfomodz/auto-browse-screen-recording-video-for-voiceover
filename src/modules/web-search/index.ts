import { Page } from 'puppeteer-core';
import { BrollModule } from '../../core/module';
import { ExtractedTopic, ModuleActionType, ModuleConfig } from '../../core/types';
import { BrowserEngine } from '../../browser/engine';
import { Logger } from '../../utils/logger';
import { humanDelay } from '../../utils/timing';

/**
 * Web Search module.
 *
 * Performs a general web search for a topic, slowly scrolls through
 * the results to create natural-looking B-roll of someone researching.
 */
export class WebSearchModule extends BrollModule {
  readonly name = 'Web Search';
  readonly actionType: ModuleActionType = 'web-search';

  constructor(config: ModuleConfig, logger: Logger) {
    super(config, logger);
  }

  async execute(page: Page, browser: BrowserEngine, topic: ExtractedTopic): Promise<number> {
    const startTime = Date.now();
    this.logger.info(`Web search: "${topic.topic}"`);

    // Perform the search
    await browser.performSearch(topic.topic);

    // Slowly scroll through results to simulate reading
    const scrollPasses = 3;
    for (let i = 0; i < scrollPasses; i++) {
      await humanDelay(1500, 2500);
      await browser.mouse.smoothScroll(300 + Math.random() * 200, 2000);
    }

    // Optionally hover over a result link
    const links = await page.$$('h3');
    if (links.length > 0) {
      const targetLink = links[Math.min(1, links.length - 1)];
      const box = await targetLink.boundingBox();
      if (box) {
        await browser.mouse.moveTo(
          box.x + box.width / 2,
          box.y + box.height / 2,
          800
        );
        await humanDelay(1000, 2000);
      }
    }

    // Scroll back up slightly
    await browser.mouse.smoothScroll(-150, 1000);
    await humanDelay(500, 1000);

    const durationSec = (Date.now() - startTime) / 1000;
    this.logger.info(`Web search complete (${durationSec.toFixed(1)}s)`);
    return durationSec;
  }
}
