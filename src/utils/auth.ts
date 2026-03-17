import { Credentials } from '../config.js';

export function maskCredentials(credentials: Credentials): Record<string, string> {
  return {
    email: credentials.email,
    password: '***' + credentials.password.slice(-2),
  };
}

export function validateCredentials(credentials: Credentials): boolean {
  if (!credentials.email || typeof credentials.email !== 'string') {
    return false;
  }

  if (!credentials.password || typeof credentials.password !== 'string') {
    return false;
  }

  return credentials.email.length > 0 && credentials.password.length > 0;
}

export function logAuthAttempt(platform: string, credentials: Credentials, logger: any): void {
  const masked = maskCredentials(credentials);
  logger.debug(`Attempting login for ${platform} with email: ${masked.email}`);
}
