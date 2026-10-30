import type { LoggerService } from '@nestjs/common';

export type WriteLog = (line: string) => void;

/** Nest start-up chatter that says nothing an operator reading the daemon log needs. */
const QUIET_CONTEXTS = new Set([
  'InstanceLoader',
  'RoutesResolver',
  'RouterExplorer',
  'NestFactory',
  'NestApplication',
]);

/** One line per entry: `<ISO time> <level> [<context>] <message>`. launchd sends stdout to the daemon log. */
export class DaemonLogger implements LoggerService {
  constructor(private readonly writeLog: WriteLog) {}

  log(message: unknown, ...rest: unknown[]): void {
    this.write('INFO', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.write('WARN', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.write('ERROR', message, rest);
  }

  private write(level: string, message: unknown, rest: unknown[]): void {
    const context = typeof rest.at(-1) === 'string' ? (rest.at(-1) as string) : 'daemon';
    if (level === 'INFO' && QUIET_CONTEXTS.has(context)) return;
    const stack = rest.find((part) => typeof part === 'string' && part.includes('\n    at '));
    const text = message instanceof Error ? (message.stack ?? message.message) : String(message);
    this.writeLog(`${new Date().toISOString()} ${level} [${context}] ${text}${stack ? `\n${stack}` : ''}`);
  }
}
