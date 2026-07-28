import { handleMessage } from './ipc/handler.js';
import type { ExtensionToHostMessage, HostToExtensionMessage } from '@job-autoapply/shared';
import { logger } from './logging/logger.js';

function writeMessage(message: HostToExtensionMessage): void {
  const json = JSON.stringify(message);
  const buffer = Buffer.from(json, 'utf-8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buffer.length, 0);
  process.stdout.write(header);
  process.stdout.write(buffer);
}

function readMessages(onMessage: (msg: ExtensionToHostMessage) => void): void {
  let buffer = Buffer.alloc(0);

  process.stdin.on('readable', () => {
    let chunk: Buffer | null;
    while ((chunk = process.stdin.read()) !== null) {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (buffer.length < 4 + length) break;

        const json = buffer.subarray(4, 4 + length).toString('utf-8');
        buffer = buffer.subarray(4 + length);

        try {
          const message = JSON.parse(json) as ExtensionToHostMessage;
          onMessage(message);
        } catch (err) {
          logger.error({ err, json }, 'Failed to parse message');
          writeMessage({ type: 'HOST_ERROR', code: 'PARSE_ERROR', message: 'Invalid JSON' });
        }
      }
    }
  });

  process.stdin.on('end', () => {
    logger.info('stdin closed, exiting');
    process.exit(0);
  });
}

logger.info('Job Auto-Apply native host started');

readMessages((message) => {
  handleMessage(message, writeMessage);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  writeMessage({ type: 'HOST_ERROR', code: 'FATAL', message: err.message });
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  logger.fatal({ err }, 'Unhandled rejection');
  writeMessage({
    type: 'HOST_ERROR',
    code: 'FATAL',
    message: err instanceof Error ? err.message : 'Unhandled rejection',
  });
});
