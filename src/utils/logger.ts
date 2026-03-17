export interface LoggerOptions {
  verbose?: boolean;
}

export class Logger {
  private verbose: boolean;

  constructor(options: LoggerOptions = {}) {
    this.verbose = options.verbose || false;
  }

  info(message: string, ...args: unknown[]): void {
    console.log(`[INFO] ${message}`, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    console.error(`[ERROR] ${message}`, ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.verbose) {
      console.log(`[DEBUG] ${message}`, ...args);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    console.warn(`[WARN] ${message}`, ...args);
  }
}

export const createLogger = (options?: LoggerOptions): Logger => {
  return new Logger(options);
};
