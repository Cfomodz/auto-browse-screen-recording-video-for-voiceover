import { Page } from 'puppeteer-core';
import { BrollModule } from '../../core/module';
import { ExtractedTopic, ModuleActionType, ModuleConfig } from '../../core/types';
import { BrowserEngine } from '../../browser/engine';
import { Logger } from '../../utils/logger';
import { humanDelay } from '../../utils/timing';

/**
 * Definition Search module.
 *
 * Searches for the definition of a key term/concept. If Google shows
 * an inline definition card, the module pauses to let it be visible.
 * Otherwise, it looks for dictionary website results (Merriam-Webster,
 * Dictionary.com, etc.) and clicks through.
 */
export class DefinitionSearchModule extends BrollModule {
  readonly name = 'Definition Search';
  readonly actionType: ModuleActionType = 'definition-search';

  private static DICTIONARY_DOMAINS = [
    'merriam-webster.com',
    'dictionary.com',
    'oxford',
    'cambridge.org/dictionary',
    'wiktionary.org',
  ];

  constructor(config: ModuleConfig, logger: Logger) {
    super(config, logger);
  }

  async execute(page: Page, browser: BrowserEngine, topic: ExtractedTopic): Promise<number> {
    const startTime = Date.now();
    const query = `define ${topic.topic}`;
    this.logger.info(`Definition search: "${query}"`);

    await browser.performSearch(query);

    // Check for Google's inline definition card
    const hasDefinitionCard = await this.checkInlineDefinition(page, browser);

    if (hasDefinitionCard) {
      this.logger.info('Found inline definition card.');
      // Pause on the definition card for the viewer to read
      await humanDelay(3000, 5000);
      // Slowly scroll to reveal more of the definition if available
      await browser.mouse.smoothScroll(150, 1500);
      await humanDelay(2000, 3000);
    } else {
      // Look for a dictionary result and click it
      this.logger.info('No inline definition — looking for dictionary results.');
      const clicked = await this.clickDictionaryResult(page, browser);

      if (clicked) {
        await humanDelay(2000, 3000);
        // Scroll through the definition page
        await browser.mouse.smoothScroll(300, 2500);
        await humanDelay(2000, 3000);
      } else {
        // Fallback: just scroll through regular results
        await browser.mouse.smoothScroll(200, 2000);
        await humanDelay(1500, 2500);
      }
    }

    const durationSec = (Date.now() - startTime) / 1000;
    this.logger.info(`Definition search complete (${durationSec.toFixed(1)}s)`);
    return durationSec;
  }

  private async checkInlineDefinition(page: Page, browser: BrowserEngine): Promise<boolean> {
    // Google's definition cards use various selectors
    const cardSelectors = [
      '[data-attrid="wa:/description"]',
      '.lr_dct_ent',                         // Google dictionary
      '[data-dobid="dfn"]',                  // Definition block
      '.xpdopen .kno-rdesc',                 // Knowledge panel
      'div[data-md]',                        // Definition marker
    ];

    for (const selector of cardSelectors) {
      const el = await page.$(selector);
      if (el) {
        const box = await el.boundingBox();
        if (box && box.height > 30) {
          // Move mouse to the definition area
          await browser.mouse.moveTo(
            box.x + box.width / 2,
            box.y + box.height / 2,
            1000
          );
          return true;
        }
      }
    }

    return false;
  }

  private async clickDictionaryResult(page: Page, browser: BrowserEngine): Promise<boolean> {
    const links = await page.$$('a[href]');

    for (const link of links) {
      const href = await page.evaluate((el) => el.href, link);
      const isDictionary = DefinitionSearchModule.DICTIONARY_DOMAINS.some(
        (domain) => href.includes(domain)
      );

      if (isDictionary) {
        const box = await link.boundingBox();
        if (box && box.y > 0 && box.y < 800) {
          await browser.mouse.moveAndClick(
            box.x + box.width / 2,
            box.y + box.height / 2,
            { durationMs: 800 }
          );
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
          return true;
        }
      }
    }

    return false;
  }
}
