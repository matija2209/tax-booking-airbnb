import { Page } from 'playwright';
import { BrowserManager } from '../utils/browser.js';
import { Logger } from '../utils/logger.js';
import { Credentials } from '../config.js';
import { parseDate, isDateInRange } from '../utils/dates.js';
import { ExtractionResult } from '../types/index.js';

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
    await this.page.goto(url, { waitUntil: 'networkidle' });
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
    this.logger.debug(`Launching browser (headless: ${headless})`);
    await this.browserManager.launch({ headless });
    await this.browserManager.createContext();
    this.page = await this.browserManager.createPage();
  }

  async cleanup(): Promise<void> {
    await this.browserManager.cleanup();
  }

  abstract extract(options: any): Promise<ExtractionResult>;
}
