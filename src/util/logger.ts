export interface LeafLogger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export function tagLogger(base: LeafLogger, tag: string): LeafLogger {
  const prefix = `[${tag}]`;
  return {
    debug: (msg, ...args) => base.debug(`${prefix} ${msg}`, ...args),
    info: (msg, ...args) => base.info(`${prefix} ${msg}`, ...args),
    warn: (msg, ...args) => base.warn(`${prefix} ${msg}`, ...args),
    error: (msg, ...args) => base.error(`${prefix} ${msg}`, ...args),
  };
}
