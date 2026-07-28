import type {
  ExtensionToHostMessage,
  HostToExtensionMessage,
  StartApply,
} from '@job-autoapply/shared';
import { profileSchema, searchCriteriaSchema } from '@job-autoapply/shared';
import { startRun, requestStop, type RunController } from '../automation/engine.js';
import { getHistory, clearAllData, getRunCounts } from '../db/client.js';
import { logger } from '../logging/logger.js';

const HOST_VERSION = '1.0.0';

let activeRun: RunController | null = null;

export type SendFn = (message: HostToExtensionMessage) => void;

export function handleMessage(
  message: ExtensionToHostMessage,
  send: SendFn,
): void {
  try {
    switch (message.type) {
      case 'PING':
        send({ type: 'PING_RESPONSE', version: HOST_VERSION, connected: true });
        break;

      case 'START_APPLY':
        handleStartApply(message, send);
        break;

      case 'STOP_APPLY':
        if (activeRun && activeRun.runId === message.runId) {
          activeRun.stop();
          requestStop();
        }
        break;

      case 'GET_HISTORY':
        send({
          type: 'HISTORY_RESPONSE',
          entries: getHistory(message.runId, message.limit ?? 100) as import('@job-autoapply/shared').HistoryEntry[],
        });
        break;

      case 'GET_RUN_SUMMARY': {
        const counts = getRunCounts(message.runId);
        send({
          type: 'RUN_SUMMARY',
          runId: message.runId,
          ...counts,
        });
        break;
      }

      case 'CLEAR_DATA':
        clearAllData();
        logger.info('All host data cleared');
        break;

      default:
        send({ type: 'HOST_ERROR', code: 'UNKNOWN_MESSAGE', message: 'Unknown message type' });
    }
  } catch (err) {
    logger.error({ err }, 'Error handling message');
    send({
      type: 'HOST_ERROR',
      code: 'HANDLER_ERROR',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}

function handleStartApply(msg: StartApply, send: SendFn): void {
  if (activeRun) {
    send({ type: 'HOST_ERROR', code: 'RUN_IN_PROGRESS', message: 'A run is already in progress' });
    return;
  }

  const profile = profileSchema.parse(msg.profile);
  const criteria = searchCriteriaSchema.parse(msg.criteria);

  const controller = startRun(
    msg.platform,
    profile,
    criteria,
    (event) => {
      if (!activeRun) return;
      send({
        type: 'STATUS_EVENT',
        runId: controller.runId,
        status: event.status,
        jobTitle: event.jobTitle,
        company: event.company,
        reason: event.reason,
        tabTitle: event.tabTitle,
        tabUrl: event.tabUrl,
      });
    },
    msg.cdpPort,
    msg.tabUrl,
  );

  activeRun = controller;

  send({
    type: 'RUN_STARTED',
    runId: controller.runId,
  });

  controller.promise
    .then((counts) => {
      send({
        type: 'RUN_SUMMARY',
        runId: controller.runId,
        ...counts,
      });
    })
    .catch((err) => {
      send({
        type: 'HOST_ERROR',
        code: 'RUN_FAILED',
        message: err instanceof Error ? err.message : 'Run failed',
      });
    })
    .finally(() => {
      if (activeRun?.runId === controller.runId) {
        activeRun = null;
      }
    });
}
