import winston from 'winston';

export type Logger = winston.Logger;

/** True when DEBUG=1 or --debug was passed (enables debug-level logs). */
export function isDebug(): boolean {
  return process.env.DEBUG === '1' || process.env.DEBUG === 'true';
}

export function createLogger(label: string): Logger {
  const level = isDebug() ? 'debug' : 'info';
  return winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.label({ label }),
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      winston.format.printf(({ timestamp, label, level, message }) => {
        return `${timestamp} [${label}] ${level}: ${message}`;
      })
    ),
    transports: [new winston.transports.Console()],
  });
}
