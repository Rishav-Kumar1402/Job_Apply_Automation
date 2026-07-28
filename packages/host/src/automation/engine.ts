import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import type { Profile, SearchCriteria } from '@job-autoapply/shared';
import {
  connectOverCDP,
  findOrOpenPlatformTab,
  isLoggedIn,
  detectBlockingUI,
  getTabInfo,
  type BrowserSession,
} from './browser.js';
import { RateLimiter } from './rateLimiter.js';
import { navigateToSearch as linkedinSearch } from './linkedin/search.js';
import {
  applyToJob as linkedinApply,
  getJobCardCount as linkedinJobCount,
  goToNextPage as linkedinNextPage,
} from './linkedin/easyApplyFlow.js';
import { navigateToSearch as naukriSearch } from './naukri/search.js';
import {
  applyToJob as naukriApply,
  getJobCardCount as naukriJobCount,
  goToNextPage as naukriNextPage,
} from './naukri/applyFlow.js';
import {
  createRun,
  finishRun,
  isDuplicate,
  recordApplication,
  getTodayApplicationCount,
  getRunCounts,
} from '../db/client.js';
import { createRunLogger } from '../logging/logger.js';
import type { ApplyResult } from './linkedin/easyApplyFlow.js';

export type StatusCallback = (event: {
  status: 'searching' | 'applied' | 'skipped' | 'failed' | 'interrupted';
  jobTitle?: string;
  company?: string;
  reason?: string;
  tabTitle?: string;
  tabUrl?: string;
}) => void;

export interface RunController {
  runId: string;
  stop: () => void;
  promise: Promise<{ applied: number; skipped: number; failed: number }>;
}

let activeController: { stopRequested: boolean } | null = null;

export function requestStop(): void {
  if (activeController) activeController.stopRequested = true;
}

export function startRun(
  platform: 'linkedin' | 'naukri',
  profile: Profile,
  criteria: SearchCriteria,
  emit: StatusCallback,
  cdpPort?: number,
  tabUrl?: string,
): RunController {
  const runId = randomUUID();
  const stopFlag = { stopRequested: false };
  activeController = stopFlag;

  const promise = executeRun(runId, platform, profile, criteria, emit, stopFlag, cdpPort, tabUrl);

  return {
    runId,
    stop: () => {
      stopFlag.stopRequested = true;
    },
    promise,
  };
}

async function executeRun(
  runId: string,
  platform: 'linkedin' | 'naukri',
  profile: Profile,
  criteria: SearchCriteria,
  emit: StatusCallback,
  stopFlag: { stopRequested: boolean },
  cdpPort?: number,
  tabUrl?: string,
): Promise<{ applied: number; skipped: number; failed: number }> {
  const log = createRunLogger(runId);
  createRun(runId, platform, criteria.dailyApplicationCap);

  let session: BrowserSession | null = null;
  let page: Page | null = null;

  try {
    session = await connectOverCDP(cdpPort);
    page = await findOrOpenPlatformTab(session, platform, tabUrl);

    const loggedIn = await isLoggedIn(page, platform);
    if (!loggedIn) {
      emit({
        status: 'interrupted',
        reason: `Please log into ${platform} in Chrome, then click Start again.`,
      });
      return getRunCounts(runId);
    }

    const tabInfo = await getTabInfo(page);
    emit({ status: 'searching', tabTitle: tabInfo.title, tabUrl: tabInfo.url });

    const todayCount = getTodayApplicationCount(platform);
    const limiter = new RateLimiter(criteria.dailyApplicationCap, todayCount);

    if (platform === 'linkedin') {
      await linkedinSearch(page, criteria);
    } else {
      await naukriSearch(page, criteria);
    }

    await page.bringToFront();

    let cardIndex = 0;
    let hasMorePages = true;

    while (hasMorePages && !stopFlag.stopRequested) {
      if (!limiter.canApply()) {
        emit({ status: 'interrupted', reason: 'Daily limit reached — resume tomorrow or raise your cap.' });
        break;
      }

      const blocking = await detectBlockingUI(page);
      if (blocking) {
        emit({
          status: 'interrupted',
          reason: 'Manual verification required — please complete it in the browser, then resume.',
        });
        break;
      }

      if (!(await isLoggedIn(page, platform))) {
        emit({ status: 'interrupted', reason: 'Session expired — please log in again.' });
        break;
      }

      const jobCount =
        platform === 'linkedin' ? await linkedinJobCount(page) : await naukriJobCount(page);

      if (cardIndex >= jobCount) {
        const nextPage =
          platform === 'linkedin' ? await linkedinNextPage(page) : await naukriNextPage(page);
        if (nextPage) {
          cardIndex = 0;
          emit({ status: 'searching', reason: 'Loading next page...' });
          continue;
        }
        hasMorePages = false;
        break;
      }

      emit({ status: 'searching', ...(await getTabInfo(page)) });

      let result: ApplyResult;
      if (platform === 'linkedin') {
        result = await linkedinApply(page, profile, cardIndex);
      } else {
        result = await naukriApply(page, profile, cardIndex);
      }

      if (isDuplicate(result.jobId, platform)) {
        cardIndex++;
        continue;
      }

      recordApplication(runId, {
        jobId: result.jobId,
        jobTitle: result.jobTitle,
        company: result.company,
        platform,
        status: result.status,
        reason: result.reason,
      });

      if (result.status === 'applied') {
        limiter.recordApplied();
      }

      emit({
        status: result.status,
        jobTitle: result.jobTitle,
        company: result.company,
        reason: result.reason,
        ...(await getTabInfo(page)),
      });

      if (result.status === 'applied' && !limiter.canApply()) {
        emit({ status: 'interrupted', reason: 'Daily limit reached.' });
        break;
      }

      cardIndex++;

      if (stopFlag.stopRequested) break;
    }

    const counts = getRunCounts(runId);
    finishRun(runId, counts);
    log.info(counts, 'Run completed');
    return counts;
  } catch (err) {
    log.error({ err }, 'Run failed');
    emit({
      status: 'failed',
      reason: err instanceof Error ? err.message : 'Unknown error',
    });
    const counts = getRunCounts(runId);
    finishRun(runId, counts);
    return counts;
  } finally {
    activeController = null;
    if (page) {
      try {
        await page.bringToFront();
      } catch {
        // tab may have been closed
      }
    }
  }
}
