import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../db/client.js';

const logDir = path.join(getDataDir(), 'logs');
fs.mkdirSync(logDir, { recursive: true });

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
  },
  pino.destination(path.join(logDir, 'host.log')),
);

export function createRunLogger(runId: string) {
  return logger.child({ runId });
}
