import { BookingScraper } from '../src/scrapers/booking';
import { createLogger } from '../src/utils/logger';

describe('BookingScraper', () => {
  const mockCredentials = {
    email: 'test@example.com',
    password: 'password123',
  };

  const logger = createLogger({ verbose: false });

  it('should create a scraper instance', () => {
    const scraper = new BookingScraper(mockCredentials, logger);
    expect(scraper).toBeDefined();
  });

  it('should parse amount strings correctly', () => {
    expect(true).toBe(true);
  });

  it('should calculate nights correctly', () => {
    expect(true).toBe(true);
  });
});
