import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '..', '.env') });

export interface Credentials {
  email: string;
  password: string;
}

export interface Config {
  airbnb: Credentials;
  booking: Credentials;
  outputDir: string;
}

function loadCredentials(platform: 'airbnb' | 'booking'): Credentials {
  const emailVar = `${platform.toUpperCase()}_EMAIL`;
  const passwordVar = `${platform.toUpperCase()}_PASSWORD`;

  const email = process.env[emailVar];
  const password = process.env[passwordVar];

  if (!email || !password) {
    throw new Error(
      `Missing credentials for ${platform}. Set ${emailVar} and ${passwordVar} environment variables.`
    );
  }

  return { email, password };
}

export function getConfig(): Config {
  return {
    airbnb: loadCredentials('airbnb'),
    booking: loadCredentials('booking'),
    outputDir: process.env.OUTPUT_DIR || join(__dirname, '..', 'output'),
  };
}

export function validateConfig(platform: 'airbnb' | 'booking'): Credentials {
  return loadCredentials(platform);
}
