import winston from 'winston';

export type Logger = winston.Logger;

export function createLogger(label: string): Logger {
  return winston.createLogger({
    level: 'info',
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
