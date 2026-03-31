import { Page } from 'playwright';
import { BrowserManager } from '../utils/browser.js';
import { Logger } from '../utils/logger.js';
import { Credentials } from '../config.js';
import { parseDate, isDateInRange } from '../utils/dates.js';
import { ExtractionResult } from '../types/index.js';
import { existsSync } from 'fs';

export abstract class BaseScraper {
  protected browserManager: BrowserManager;
  protected logger: Logger;
  protected credentials: Credentials;
  protected page: Page | null = null;

  constructor(credentials: Credentials, logger: Logger) {
    this.credentials = credentials;
    this.logger = logger;
    this.browserManager = new BrowserManager({ timeout: 30000 });
  }

  protected async login(loginUrl: string, emailSelector: string, passwordSelector: string, submitSelector: string): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    this.logger.info('Navigating to login page...');
    await this.page.goto(loginUrl, { waitUntil: 'networkidle' });

    this.logger.debug('Filling email field...');
    await this.page.fill(emailSelector, this.credentials.email);

    this.logger.debug('Filling password field...');
    await this.page.fill(passwordSelector, this.credentials.password);

    this.logger.info('Submitting login form...');
    await this.page.click(submitSelector);

    // Wait for navigation to complete
    await this.page.waitForNavigation({ waitUntil: 'networkidle' });
    this.logger.info('Login successful');
  }

  protected async navigateTo(url: string): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    this.logger.debug(`Navigating to ${url}...`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  protected filterDateRange(dateString: string, startDate?: string, endDate?: string): boolean {
    try {
      const date = parseDate(dateString);
      const start = startDate ? parseDate(startDate) : undefined;
      const end = endDate ? parseDate(endDate) : undefined;

      return isDateInRange(date, start, end);
    } catch {
      this.logger.warn(`Failed to parse date: ${dateString}`);
      return true; // Include if we can't parse
    }
  }

  async initialize(): Promise<void> {
    const headless = process.env.HEADLESS !== 'false';
    const devtools = process.env.DEVTOOLS === 'true';
    const channel = process.env.BROWSER_CHANNEL || (headless ? undefined : 'chrome');
    this.logger.debug(
      `Launching browser (headless: ${headless}, devtools: ${devtools}, channel: ${channel || 'default'})`
    );
    await this.browserManager.launch({ headless, devtools, channel });
    
    let storageState: string | undefined = undefined;
    if (existsSync('state.json')) {
      this.logger.debug('Found existing session state file (state.json)');
      storageState = 'state.json';
    }
    
    await this.browserManager.createContext({ storageState });
    this.page = await this.browserManager.createPage();
  }

  async cleanup(): Promise<void> {
    if (process.env.KEEP_OPEN === 'true') {
      this.logger.info('KEEP_OPEN=true set. Skipping browser cleanup for manual inspection.');
      return;
    }

    await this.browserManager.cleanup();
  }

  abstract extract(options: any): Promise<ExtractionResult>;
}
