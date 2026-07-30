import type { Profile, SearchCriteria } from '@job-autoapply/shared';

export type RunStatus = 'searching' | 'applied' | 'skipped' | 'failed' | 'interrupted';

let stopRequested = false;
let currentRunId: string | null = null;
let automationActive = false;
/** Bumped on forced resume so in-flight LinkedIn loops exit instead of double-applying. */
let automationPassId = 0;
/** Mirrors chrome.storage force-stop so async runs halt even if the tab message is late. */
let forceStopEpoch = 0;

function isTopWindow(): boolean {
  try {
    return window.top === window;
  } catch {
    return true;
  }
}

const PENDING_KEY = 'job-autoapply-pending-run';
const STOP_KEY = 'job-autoapply-stop';
const EXEC_KEY = 'job-autoapply-exec';
const HANDLED_KEY = 'job-autoapply-handled';
const FORCE_STOP_STORAGE_KEY = 'job-autoapply-force-stop';

function claimPage(runId: string, kind: string, token: string, force = false): boolean {
  const key = `${runId}:${kind}:${token}`;
  if (!force && sessionStorage.getItem(HANDLED_KEY) === key) return false;
  sessionStorage.setItem(HANDLED_KEY, key);
  return true;
}

function releasePageClaim(): void {
  sessionStorage.removeItem(HANDLED_KEY);
}

function isStopped(): boolean {
  return stopRequested || sessionStorage.getItem(STOP_KEY) === '1';
}

function clearRunFlags(): void {
  sessionStorage.removeItem(STOP_KEY);
  sessionStorage.removeItem(EXEC_KEY);
}

function beginExecution(runId: string, force = false): boolean {
  if (force) {
    sessionStorage.setItem(EXEC_KEY, `${runId}:${Date.now()}`);
    return true;
  }
  const marker = sessionStorage.getItem(EXEC_KEY);
  if (marker?.startsWith(`${runId}:`)) return false;
  sessionStorage.setItem(EXEC_KEY, `${runId}:${Date.now()}`);
  return true;
}

function isExternalApplyJob(): boolean {
  // Only trust an actual company-site control — never body text alone
  // (Naukri pages often mention "company site" in other widgets.)
  return Boolean(findExternalApplyControl());
}

function isExternalApplyLabel(text: string): boolean {
  const t = normalizeText(text);
  if (!t) return false;
  // Naukri variants: "Apply on company site/website", "Apply to company website", etc.
  if (
    t.includes('company site')
    || t.includes('company website')
    || t.includes('company\'s website')
    || t.includes('companys website')
    || t.includes('employer website')
    || t.includes('external website')
  ) {
    return t.includes('apply') || t === 'company site' || t === 'company website';
  }
  if (/^apply (on|to|via|at) (the )?(company|employer|external)/i.test(t)) return true;
  if (/apply.*(company|employer).*(site|website|portal)/i.test(t)) return true;
  return false;
}

function getElementText(el: HTMLElement): string {
  return normalizeText([
    el.textContent,
    el.getAttribute('aria-label'),
    el.getAttribute('title'),
    el.getAttribute('value'),
    el.getAttribute('data-title'),
  ].filter(Boolean).join(' '));
}

function isClickableElement(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  return tag === 'button'
    || tag === 'a'
    || el.getAttribute('role') === 'button'
    || Boolean(el.onclick)
    || el.tabIndex >= 0
    || normalizeText(`${el.id} ${el.className}`).includes('apply');
}

function clickableExternalCandidate(el: HTMLElement): HTMLElement | null {
  const clickable = el.closest<HTMLElement>('button, a[href], [role="button"], [onclick], [tabindex]');
  if (clickable && isVisible(clickable)) return clickable;
  return isClickableElement(el) ? el : null;
}

function findExternalApplyControl(): HTMLElement | null {
  const candidates = new Map<HTMLElement, number>();
  const addCandidate = (el: HTMLElement, baseScore: number) => {
    if (!isVisible(el)) return;
    const clickable = clickableExternalCandidate(el);
    if (!clickable || !isVisible(clickable)) return;

    const rect = clickable.getBoundingClientRect();
    const isHugeContainer = rect.width > window.innerWidth * 0.8 || rect.height > window.innerHeight * 0.35;
    if (isHugeContainer && clickable.tagName.toLowerCase() === 'div') return;

    const text = getElementText(clickable) || getElementText(el);
    if (!isExternalApplyLabel(text)) return;

    const tag = clickable.tagName.toLowerCase();
    const score = baseScore
      + (tag === 'button' ? 30 : 0)
      + (tag === 'a' ? 25 : 0)
      + (clickable.getAttribute('role') === 'button' ? 20 : 0)
      + (text.includes('apply on company site') ? 50 : 0)
      + (text.includes('apply on company website') ? 50 : 0)
      + (text.includes('apply to company website') ? 50 : 0)
      + (text.includes('apply to company site') ? 50 : 0)
      + (text.includes('company website') || text.includes('company site') ? 15 : 0)
      - Math.round((rect.width * rect.height) / 5000);
    candidates.set(clickable, Math.max(candidates.get(clickable) ?? 0, score));
  };

  // Include #apply-button — on company-site jobs Naukri reuses that id
  document.querySelectorAll<HTMLElement>(
    '#apply-button, button#apply-button, button, a[href], [role="button"], [onclick]',
  ).forEach((el) => addCandidate(el, isClickableElement(el) ? 20 : 0));

  // Secondary: labeled spans near apply areas (avoid scanning every page div)
  document.querySelectorAll<HTMLElement>(
    '[class*="apply"] span, [class*="Apply"] span, [class*="styles_jhc"] span, [class*="jd-header"] span, [class*="jdheader"] span',
  ).forEach((el) => addCandidate(el, 5));

  return [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([el]) => el)[0] ?? null;
}

async function waitForExternalOrNormalApply(timeoutMs = 8000): Promise<{
  external: HTMLElement | null;
  apply: HTMLElement | null;
}> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs && !isStopped()) {
    const external = findExternalApplyControl();
    const apply = findNaukriApplyButtonSync();

    // Company-site CTA wins over a misclassified normal Apply
    if (external) {
      return { external, apply: null };
    }
    if (apply && !isExternalApplyLabel(getElementText(apply))) {
      return { external: null, apply };
    }
    await sleep(150);
  }

  const external = findExternalApplyControl();
  const apply = findNaukriApplyButtonSync();
  if (external) return { external, apply: null };
  if (apply && !isExternalApplyLabel(getElementText(apply))) {
    return { external: null, apply };
  }
  return { external: null, apply: null };
}

function getExternalApplyHref(control: HTMLElement | null): string | undefined {
  if (!control) return undefined;

  const roots = [
    control,
    control.closest<HTMLElement>('a[href], button, [role="button"], [onclick]'),
    control.parentElement,
    control.parentElement?.parentElement,
  ].filter(Boolean) as HTMLElement[];

  for (const root of roots) {
    const anchor = (root.matches('a[href]') ? root : root.querySelector('a[href]')) as HTMLAnchorElement | null;
    if (anchor?.href) return anchor.href;

    for (const attr of ['data-href', 'data-url', 'data-redirect-url', 'data-apply-url', 'data-target-url', 'href']) {
      const val = root.getAttribute(attr);
      if (val) {
        try {
          return new URL(val, window.location.href).href;
        } catch {
          return val;
        }
      }
    }

    const reactUrl = extractReactNavigationUrl(root);
    if (reactUrl) return reactUrl;
  }

  return undefined;
}

function extractReactNavigationUrl(el: HTMLElement): string | undefined {
  const record = el as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!key.startsWith('__reactProps$') && !key.startsWith('__reactFiber$')) continue;
    const raw = JSON.stringify(record[key] ?? {});
    const match = raw.match(/https?:\\\/\\\/[^"\\]+|https?:\/\/[^"\\s]+/i);
    if (!match?.[0]) continue;
    const cleaned = match[0].replace(/\\\//g, '/');
    try {
      return new URL(cleaned, window.location.href).href;
    } catch {
      return cleaned;
    }
  }
  return undefined;
}

function isUsableNavigationUrl(url: string | undefined): url is string {
  if (!url) return false;
  const normalized = url.trim().toLowerCase();
  return Boolean(normalized)
    && !normalized.startsWith('javascript:')
    && !normalized.startsWith('#')
    && !normalized.startsWith('mailto:')
    && !normalized.startsWith('tel:');
}

function isNaukriCompanySiteConfirmationPage(): boolean {
  const href = window.location.href.toLowerCase();
  // showAcp is Naukri's company-website redirect interstitial
  if (href.includes('showacp')) return true;
  // Do NOT treat /myapply/ as company-site — that is often the post-Apply success page
  const text = document.body?.innerText?.toLowerCase() ?? '';
  return text.includes('redirected to the company website')
    || text.includes('you will be redirected to the company');
}

/**
 * Synthetic clicks are not trusted user gestures, so Chrome blocks Naukri's
 * window.open(companyUrl). The MAIN-world hook is injected by the background via
 * chrome.scripting (inline <script> tags are blocked by CSP).
 */
function installWindowOpenCapture(onUrl: (url: string) => void): () => void {
  const handler = (event: MessageEvent) => {
    const data = event.data as { source?: string; type?: string; url?: string } | null;
    if (!data || data.source !== 'job-autoapply' || data.type !== 'WINDOW_OPEN') return;
    if (typeof data.url === 'string' && isUsableNavigationUrl(data.url)) onUrl(data.url);
  };
  window.addEventListener('message', handler);
  return () => {
    window.removeEventListener('message', handler);
  };
}

/**
 * Background replies can never arrive (evicted service worker, reloaded extension).
 * Always race with a timeout so a single message can't freeze the whole run.
 */
function isExtensionContextValid(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function safeRuntimeSend(message: unknown): void {
  if (!isExtensionContextValid()) {
    // Extension was reloaded mid-run — halt quietly (avoids "Extension context invalidated")
    stopRequested = true;
    automationActive = false;
    return;
  }
  try {
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    stopRequested = true;
    automationActive = false;
  }
}

function sendRuntimeMessage<T>(message: unknown, timeoutMs = 5000): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finishOnce = (value: T | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    if (!isExtensionContextValid()) {
      finishOnce(null);
      return;
    }
    const timer = setTimeout(() => finishOnce(null), timeoutMs);
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const err = chrome.runtime.lastError?.message ?? '';
        if (/context invalidated|extension context/i.test(err)) {
          stopRequested = true;
          automationActive = false;
        }
        clearTimeout(timer);
        finishOnce((response as T) ?? null);
      });
    } catch {
      clearTimeout(timer);
      stopRequested = true;
      automationActive = false;
      finishOnce(null);
    }
  });
}

async function ensureWindowOpenHook(): Promise<void> {
  await sendRuntimeMessage({ type: 'ENSURE_WINDOW_OPEN_HOOK' }, 4000);
}

function trackExternalApplyNavigation(lead: ExternalCompanyLead, returnUrl: string): void {
  safeRuntimeSend({
    type: 'TRACK_EXTERNAL_APPLY_NAVIGATION',
    payload: {
      runId: currentRunId,
      lead,
      returnUrl,
    },
  });
}

function openExternalApplyUrl(url: string, lead: ExternalCompanyLead, returnUrl: string): void {
  safeRuntimeSend({
    type: 'OPEN_EXTERNAL_APPLY_URL',
    payload: {
      runId: currentRunId,
      url,
      lead,
      returnUrl,
    },
  });
}

function notifyCompanyRedirectConfirmation(returnUrl: string): void {
  safeRuntimeSend({
    type: 'EXTERNAL_APPLY_CONFIRMATION_REACHED',
    payload: {
      runId: currentRunId,
      returnUrl,
    },
  });
}

function isJobBoardUrl(url: string): boolean {
  const host = url.toLowerCase();
  return host.includes('naukri.com') || host.includes('linkedin.com');
}

async function handleCompanySiteApply(
  runId: string,
  returnUrl: string,
  lead: ExternalCompanyLead,
  control: HTMLElement | null,
  knownHref: string | undefined,
): Promise<void> {
  sessionStorage.setItem(`job-autoapply-external-pending-${runId}`, '1');
  trackExternalApplyNavigation(lead, returnUrl);

  let opened = false;
  const openCaptured = (url: string) => {
    if (opened || !isUsableNavigationUrl(url)) return;
    // Prefer real company URLs; LinkedIn/Naukri redirectors are still opened so watches can follow
    opened = true;
    emit({
      status: 'searching',
      jobTitle: lead.jobTitle,
      company: lead.company,
      reason: 'Opening company website in new tab...',
    });
    openExternalApplyUrl(url, lead, returnUrl);
  };

  const restoreOpen = installWindowOpenCapture(openCaptured);
  await ensureWindowOpenHook();
  await sleep(200);

  try {
    if (isUsableNavigationUrl(knownHref) && !isJobBoardUrl(knownHref)) {
      openCaptured(knownHref);
      return;
    }

    if (control) {
      forceClick(control);
      clickElementCenter(control);
      await sleep(800);

      if (!opened && isUsableNavigationUrl(knownHref)) {
        openCaptured(knownHref);
        return;
      }

      const start = Date.now();
      while (!opened && Date.now() - start < 5000 && !isStopped()) {
        await sleep(150);
      }
    }

    if (!opened && isUsableNavigationUrl(knownHref)) {
      openCaptured(knownHref);
    }

    if (!opened) {
      emit({
        status: 'searching',
        jobTitle: lead.jobTitle,
        company: lead.company,
        reason: 'Waiting for company website tab...',
      });
    }
  } finally {
    setTimeout(restoreOpen, 5000);
  }
}

function detectNaukriSiteError(): boolean {
  const text = (document.body?.innerText ?? '').toLowerCase().slice(0, 4000);
  // Strong signals only — "please try again later" alone appears on many normal pages
  if (text.includes('too many requests')) return true;
  if (text.includes('error while processing your request')) return true;
  if (text.includes('unable to process your request')) return true;
  if (text.includes('something went wrong') && /try again|later|error/.test(text)) return true;
  if (
    text.includes('please try again later')
    && (/rate limit|too many|processing your request|technical (error|issue)|service (is )?unavailable|403|429/.test(text))
  ) {
    return true;
  }
  return false;
}

/** Informational recruiter notes that are not answerable questions. */
function isNaukriDisclaimerOrNote(question: string): boolean {
  const q = (question || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!q || q.length < 12) return false;
  if (/\?$/.test(q.trim()) && /^(are you|do you|have you|will you|what|how|where|when|which|can you)\b/.test(q)) {
    return false;
  }
  return /please note that|we will reach out|only those applicants|satisfy the criteria|thank you for (your )?interest|kindly note|for your information|this (job|role) requires|shortlisted candidates/i.test(q)
    && !/^(are you|do you|have you|how many|what is|where|which)/i.test(q);
}

interface NaukriRunState {
  platform?: 'naukri';
  runId: string;
  profile: Profile;
  criteria: SearchCriteria;
  phase: 'list' | 'detail';
  jobIndex: number;
  counts: { applied: number; skipped: number; failed: number };
  jobTitle?: string;
  company?: string;
  processedDetailUrls: string[];
  /** company|title keys so we never reopen the same posting after URL variants */
  processedJobKeys?: string[];
  currentDetailUrl?: string;
  rateLimitHits?: number;
  /** Consecutive Naukri rate-limit skips — stop after 2 in a row. */
  consecutiveRateLimits?: number;
  /** Naukri jobAge query (1 / 3 / 7). Widens automatically when results run out. */
  naukriJobAge?: 1 | 3 | 7;
}

interface LinkedInRunState {
  platform: 'linkedin';
  runId: string;
  profile: Profile;
  criteria: SearchCriteria;
  jobIndex: number;
  counts: { applied: number; skipped: number; failed: number };
  processedJobKeys: string[];
}

interface ExternalCompanyLead {
  jobTitle: string;
  company: string;
  naukriUrl: string;
  externalUrl?: string;
  skipReason?: string;
  sourceType?: 'company-site' | 'skipped' | 'applied';
  capturedAt: string;
}

function normalizeJobUrl(url: string): string {
  return url.split('?')[0].split('#')[0];
}

/** Stable id from Naukri listing URLs so list vs detail URL variants still match. */
function naukriJobIdFromUrl(url: string): string | null {
  const cleaned = normalizeJobUrl(url);
  const match = cleaned.match(/(\d{8,})\s*$/)
    || cleaned.match(/job-listings[^/]*?-(\d{6,})/i)
    || cleaned.match(/-(\d{10,})(?:\/|$)/);
  return match?.[1] ?? null;
}

function naukriJobKey(jobTitle?: string, company?: string): string {
  return `${normalizeText(jobTitle || '')}|${normalizeText(company || '')}`;
}

function isNaukriDetailProcessed(state: NaukriRunState, url: string | undefined | null): boolean {
  if (!url) return false;
  const normalized = normalizeJobUrl(url);
  if (!normalized || normalized.includes('/undefined')) return false;
  if (state.processedDetailUrls.includes(normalized)) return true;
  const jobId = naukriJobIdFromUrl(normalized);
  if (jobId) {
    return state.processedDetailUrls.some((item) => naukriJobIdFromUrl(item) === jobId || item.includes(jobId));
  }
  return false;
}

function isNaukriJobHandled(state: NaukriRunState, url?: string | null, jobTitle?: string, company?: string): boolean {
  if (isNaukriDetailProcessed(state, url)) return true;
  if (!state.processedJobKeys) state.processedJobKeys = [];
  const key = naukriJobKey(jobTitle, company);
  if (key !== '|' && state.processedJobKeys.includes(key)) return true;
  return false;
}

function markJobProcessed(state: NaukriRunState, detailUrl: string | undefined | null): void {
  if (!state.processedDetailUrls) state.processedDetailUrls = [];
  if (!state.processedJobKeys) state.processedJobKeys = [];

  const candidates = [detailUrl, state.currentDetailUrl]
    .filter((u): u is string => Boolean(u && String(u).trim()));
  for (const candidate of candidates) {
    const normalized = normalizeJobUrl(candidate.trim());
    if (!normalized || normalized.includes('/undefined') || normalized.includes('/null')) continue;
    if (!state.processedDetailUrls.includes(normalized)) {
      state.processedDetailUrls.push(normalized);
    }
  }

  const key = naukriJobKey(state.jobTitle, state.company);
  if (key !== '|' && !state.processedJobKeys.includes(key)) {
    state.processedJobKeys.push(key);
  }
}

/** How many times a posting may be reopened before the run gives up on it. */
const NAUKRI_MAX_JOB_OPENS = 6;

/**
 * Recovering from a mid-job bounce back to the search list is not a fresh attempt.
 * It gets its own budget so an applyable job is never skipped as "already attempted".
 */
const NAUKRI_MAX_BOUNCE_REOPENS = 3;

function noteNaukriDetailAttempt(url: string): number {
  const key = `job-autoapply-open-count-${normalizeJobUrl(url)}`;
  const next = Number(sessionStorage.getItem(key) || '0') + 1;
  sessionStorage.setItem(key, String(next));
  return next;
}

/**
 * A job open is a full page navigation. Forced resumes (background sends several after a
 * company-site tab closes) can fire while the list page is still on screen — without this
 * marker they look like "the job bounced back to the list" and burn the retry budget.
 */
const NAUKRI_NAV_INTENT_KEY = 'job-autoapply-nav-intent';
const NAUKRI_NAV_INTENT_TTL_MS = 25000;
const NAUKRI_MAX_NAV_RETRIES = 3;

interface NaukriNavIntent {
  url: string;
  at: number;
  retries: number;
}

function noteNaukriNavIntent(url: string, retries = 0): void {
  try {
    sessionStorage.setItem(
      NAUKRI_NAV_INTENT_KEY,
      JSON.stringify({ url: normalizeJobUrl(url), at: Date.now(), retries }),
    );
  } catch {
    /* storage unavailable */
  }
}

function readNaukriNavIntent(): NaukriNavIntent | null {
  try {
    const raw = sessionStorage.getItem(NAUKRI_NAV_INTENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as NaukriNavIntent;
    if (!parsed?.url || typeof parsed.at !== 'number') return null;
    return { url: parsed.url, at: parsed.at, retries: Number(parsed.retries) || 0 };
  } catch {
    return null;
  }
}

function clearNaukriNavIntent(): void {
  sessionStorage.removeItem(NAUKRI_NAV_INTENT_KEY);
}

function externalPauseKey(runId?: string | null): string {
  return `job-autoapply-external-tab-open-${runId || currentRunId || 'none'}`;
}

/** Safety net: a lost "tab closed" message must not park the run forever. */
const EXTERNAL_PAUSE_MAX_MS = 15 * 60 * 1000;

/** Company-site tab is open: the run must stay parked until the user closes that tab. */
function isExternalPauseActive(runId?: string | null): boolean {
  const ids = [runId, currentRunId, loadNaukriState()?.runId].filter(Boolean) as string[];
  return ids.some((id) => {
    const value = sessionStorage.getItem(externalPauseKey(id));
    if (!value) return false;
    const startedAt = Number(value);
    if (Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt > EXTERNAL_PAUSE_MAX_MS) {
      sessionStorage.removeItem(externalPauseKey(id));
      return false;
    }
    return true;
  });
}

function setExternalPause(runId: string): void {
  sessionStorage.setItem(externalPauseKey(runId), String(Date.now()));
}

function clearExternalPause(runId?: string | null): void {
  const ids = [runId, currentRunId, loadNaukriState()?.runId].filter(Boolean) as string[];
  for (const id of ids) sessionStorage.removeItem(externalPauseKey(id));
}

function countNaukriRateLimits(state: NaukriRunState): number {
  state.rateLimitHits = (state.rateLimitHits ?? 0) + 1;
  state.consecutiveRateLimits = (state.consecutiveRateLimits ?? 0) + 1;
  return state.rateLimitHits;
}

function clearNaukriConsecutiveRateLimits(state: NaukriRunState): void {
  state.consecutiveRateLimits = 0;
}

const RATE_LIMIT_STOP_MESSAGE =
  'Naukri is rate-limiting applications. Automation stopped — wait 10–15 minutes, then try again.';

function stopForNaukriRateLimit(state: NaukriRunState): void {
  saveNaukriState(state);
  emit({
    status: 'failed',
    reason: RATE_LIMIT_STOP_MESSAGE,
  });
  safeRuntimeSend({
    type: 'REPORT_AUTOMATION_EVENT',
    payload: {
      type: 'AUTO_STOP',
      runId: currentRunId,
      reason: RATE_LIMIT_STOP_MESSAGE,
      toast: true,
      toastTone: 'warning',
      applied: state.counts.applied,
      skipped: state.counts.skipped,
      failed: state.counts.failed,
    },
  });
  finish(state.counts);
}

/** Skip the current Naukri job and always advance — never reopen the same failing posting. */
function skipNaukriJobAndAdvance(
  state: NaukriRunState,
  reason: string,
  detailUrl?: string | null,
): void {
  const listingUrl = resolveNaukriListingUrl(detailUrl || state.currentDetailUrl || window.location.href);
  const alreadyHandled = isNaukriJobHandled(state, listingUrl, state.jobTitle, state.company)
    || isNaukriJobHandled(state, detailUrl, state.jobTitle, state.company);

  markJobProcessed(state, listingUrl);
  markJobProcessed(state, state.currentDetailUrl);
  markJobProcessed(state, detailUrl);
  const skipUrl = normalizeJobUrl(state.currentDetailUrl || listingUrl || '');
  if (skipUrl) {
    sessionStorage.setItem(`job-autoapply-open-count-${skipUrl}`, String(NAUKRI_MAX_JOB_OPENS));
    sessionStorage.setItem(`job-autoapply-skip-recorded-${normalizeJobUrl(listingUrl || skipUrl)}`, '1');
    sessionStorage.removeItem(`job-autoapply-bounce-${state.runId}-${skipUrl}`);
  }

  if (!alreadyHandled) {
    state.counts.skipped++;
    const isRateLimit = /rate limit/i.test(reason);
    if (isRateLimit) {
      countNaukriRateLimits(state);
    } else {
      clearNaukriConsecutiveRateLimits(state);
    }
    recordSkippedLead(state.jobTitle, state.company, reason, listingUrl);
    emit({
      status: 'skipped',
      jobTitle: state.jobTitle,
      company: state.company,
      reason,
    });
  }

  sessionStorage.removeItem(`job-autoapply-post-apply-${state.runId}`);
  releasePageClaim();
  sessionStorage.removeItem(EXEC_KEY);

  // Stop early on sustained rate limiting (2 in a row, or 3 total this run)
  const isRateLimit = /rate limit/i.test(reason);
  if (
    isRateLimit
    && ((state.consecutiveRateLimits ?? 0) >= 2 || (state.rateLimitHits ?? 0) >= 3)
  ) {
    stopForNaukriRateLimit(state);
    return;
  }

  saveNaukriState(state);
  returnToNaukriSearch(state, state.jobIndex + 1);
}

/** Post-apply / redirect pages (saveApply, showAcp, myapply) are useless as report links. */
function isNaukriPostApplyUrl(url: string): boolean {
  return /naukri\.com\/(myapply|saveapply|showacp)/i.test(url)
    || /\/(saveapply|showacp)\b/i.test(url);
}

/** Job id carried by post-apply URLs (strJobsarr=[id] or the multiApplyResp key). */
function naukriJobIdFromApplyUrl(url: string): string | null {
  const fromList = url.match(/strJobsarr=\[?(\d{8,})/i)?.[1];
  if (fromList) return fromList;
  const fromResp = url.match(/multiApplyResp=[^&]*?(\d{8,})/i)?.[1];
  return fromResp ?? null;
}

/** Job title Naukri appends to saveApply URLs — used when run state lost the title. */
function naukriJobTitleFromApplyUrl(url: string): string | null {
  const raw = url.match(/[?&]jobTitle=([^&]+)/i)?.[1];
  if (!raw) return null;
  try {
    const decoded = decodeURIComponent(raw.replace(/\+/g, ' ')).trim();
    return decoded.length >= 3 ? decoded : null;
  } catch {
    return null;
  }
}

/** Listing URL for the report. Returns '' when only post-apply URLs are available. */
function resolveNaukriListingUrl(preferred?: string | null): string {
  const state = loadNaukriState();
  const fromState = state?.currentDetailUrl;
  const canonical = (document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null)?.href;
  const ogUrl = (document.querySelector('meta[property="og:url"]') as HTMLMetaElement | null)?.content;
  const rawCandidates = [preferred, fromState, window.location.href, canonical, ogUrl]
    .filter((u): u is string => Boolean(u && u.trim()))
    .map((u) => u.trim());

  const candidates = rawCandidates
    .map((u) => normalizeJobUrl(u))
    .filter((u) => !isNaukriPostApplyUrl(u));

  const isListing = (u: string) =>
    /job-listings|job-details|\/job\//i.test(u)
    || (/naukri\.com\/[^/?#]+-\d+$/i.test(u));

  for (const u of candidates) {
    if (isListing(u)) return u;
  }

  // On a saveApply/showAcp page: recover the real posting from the job id we already visited
  const applyJobId = rawCandidates.map(naukriJobIdFromApplyUrl).find(Boolean);
  if (applyJobId) {
    const known = (state?.processedDetailUrls ?? []).find((u) => u.includes(applyJobId));
    if (known) return known;
  }

  for (const u of candidates) {
    if (
      u.includes('naukri.com')
      && u.length > 40
      && !/\/(mnjuser|jobs-search|logout|login|recruit\/)/i.test(u)
      && !/\/jobs\/?$/i.test(u)
    ) {
      return u;
    }
  }
  return candidates[0] ?? '';
}

function recordExternalApplyLead(lead: ExternalCompanyLead): void {
  const naukriUrl = resolveNaukriListingUrl(lead.naukriUrl);
  const fallback = isNaukriPostApplyUrl(lead.naukriUrl || '') ? '' : lead.naukriUrl;
  safeRuntimeSend({
    type: 'RECORD_EXTERNAL_APPLY_LEAD',
    payload: {
      runId: currentRunId,
      lead: {
        ...lead,
        naukriUrl: naukriUrl || fallback || 'Not captured',
      },
    },
  });
}

function recordSkippedLead(
  jobTitle: string | undefined,
  company: string | undefined,
  reason: string,
  naukriUrl?: string,
): void {
  const state = loadNaukriState();
  const listingUrl = resolveNaukriListingUrl(naukriUrl ?? state?.currentDetailUrl ?? window.location.href);
  const title = jobTitle
    ?? state?.jobTitle
    ?? naukriJobTitleFromApplyUrl(window.location.href)
    ?? undefined;
  const org = company ?? state?.company ?? undefined;

  // A row with no job, no company and no listing link is only noise in the report
  if (!listingUrl && !title && !org) {
    emit({ status: 'searching', reason: `Skip not reported (job could not be identified): ${reason}` });
    return;
  }

  recordExternalApplyLead({
    jobTitle: title ?? 'Unknown',
    company: org ?? 'Unknown',
    naukriUrl: listingUrl,
    skipReason: reason,
    sourceType: 'skipped',
    capturedAt: new Date().toISOString(),
  });
}

function recordAppliedLead(
  jobTitle: string | undefined,
  company: string | undefined,
  naukriUrl?: string,
): void {
  const state = loadNaukriState();
  const listingUrl = resolveNaukriListingUrl(
    naukriUrl ?? state?.currentDetailUrl ?? window.location.href,
  );
  const title = jobTitle
    ?? state?.jobTitle
    ?? naukriJobTitleFromApplyUrl(window.location.href)
    ?? undefined;
  const org = company ?? state?.company ?? undefined;
  if (!listingUrl && !title && !org) return;

  recordExternalApplyLead({
    jobTitle: title ?? 'Unknown',
    company: org ?? 'Unknown',
    naukriUrl: listingUrl || window.location.href,
    skipReason: 'Applied',
    sourceType: 'applied',
    capturedAt: new Date().toISOString(),
  });
}

function saveNaukriState(state: NaukriRunState): void {
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ...state, platform: 'naukri' as const }));
}

function saveLinkedInState(state: LinkedInRunState): void {
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ...state, platform: 'linkedin' as const }));
}

function loadNaukriState(): NaukriRunState | null {
  const raw = sessionStorage.getItem(PENDING_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      platform?: string;
      jobIndex?: number;
      phase?: string;
      runId?: string;
      profile?: Profile;
      criteria?: SearchCriteria;
      counts?: { applied: number; skipped: number; failed: number };
      processedDetailUrls?: string[];
      jobTitle?: string;
      company?: string;
      currentDetailUrl?: string;
    };
    if (parsed.platform === 'linkedin') return null;
    if (parsed.platform === 'naukri' || (typeof parsed.jobIndex === 'number' && parsed.phase)) {
      return parsed as NaukriRunState;
    }
    return null;
  } catch {
    return null;
  }
}

function loadLinkedInState(): LinkedInRunState | null {
  const raw = sessionStorage.getItem(PENDING_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LinkedInRunState> & { platform?: string; criteria?: SearchCriteria };
    if (parsed.platform === 'linkedin') {
      return {
        platform: 'linkedin',
        runId: parsed.runId!,
        profile: parsed.profile!,
        criteria: parsed.criteria!,
        jobIndex: parsed.jobIndex ?? 0,
        counts: parsed.counts ?? { applied: 0, skipped: 0, failed: 0 },
        processedJobKeys: parsed.processedJobKeys ?? [],
      };
    }
    // Bare pending used only for initial LinkedIn navigation
    if (!parsed.platform && parsed.criteria?.platform === 'linkedin' && parsed.runId && parsed.profile) {
      return {
        platform: 'linkedin',
        runId: parsed.runId,
        profile: parsed.profile,
        criteria: parsed.criteria,
        jobIndex: 0,
        counts: { applied: 0, skipped: 0, failed: 0 },
        processedJobKeys: [],
      };
    }
    return null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (isStopped() || Date.now() - start >= ms) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(50, Math.max(10, ms - (Date.now() - start))));
    };
    tick();
  });
}

function randomDelay(min: number, max: number): Promise<void> {
  return sleep(min + Math.random() * (max - min));
}

let lastProgressAt = Date.now();
let stallWatchdog: number | null = null;

function emit(event: {
  status: RunStatus;
  jobTitle?: string;
  company?: string;
  reason?: string;
  applied?: number;
  skipped?: number;
  failed?: number;
}): void {
  if (isStopped() && event.status !== 'interrupted') return;
  // Iframes must not spam the live log — only the top frame reports progress
  if (!isTopWindow()) return;
  lastProgressAt = Date.now();
  if (!currentRunId) return;
  safeRuntimeSend({
    type: 'REPORT_AUTOMATION_EVENT',
    payload: { type: 'STATUS_EVENT', runId: currentRunId, ...event },
  });
}

function emitLinkedInCounters(counts: { applied: number; skipped: number; failed: number }): void {
  if (!currentRunId || !isTopWindow()) return;
  lastProgressAt = Date.now();
  safeRuntimeSend({
    type: 'REPORT_AUTOMATION_EVENT',
    payload: {
      type: 'COUNTERS_UPDATED',
      runId: currentRunId,
      applied: counts.applied,
      skipped: counts.skipped,
      failed: counts.failed,
    },
  });
}

/** A stalled await (unanswered background message, frozen SPA) must never freeze the run. */
function startStallWatchdog(): void {
  if (stallWatchdog != null) return;
  stallWatchdog = window.setInterval(() => {
    if (!isExtensionContextValid()) {
      stopRequested = true;
      automationActive = false;
      if (stallWatchdog != null) {
        window.clearInterval(stallWatchdog);
        stallWatchdog = null;
      }
      return;
    }
    if (!automationActive || isStopped()) return;
    if (isExternalPauseActive()) {
      lastProgressAt = Date.now();
      return;
    }
    if (Date.now() - lastProgressAt < 90000) return;

    lastProgressAt = Date.now();
    automationActive = false;
    emit({ status: 'searching', reason: 'No progress for 90s — restarting this step...' });
    releasePageClaim();
    sessionStorage.removeItem(EXEC_KEY);
    void resumePendingRun(true);
  }, 15000);
}

function finish(counts: { applied: number; skipped: number; failed: number }): void {
  // Prefer top-frame sessionStorage so same-origin iframes share one finish marker.
  let store: Storage = sessionStorage;
  try {
    if (window.top?.sessionStorage) store = window.top.sessionStorage;
  } catch {
    // cross-origin iframe — use this frame's sessionStorage
  }
  const finishKey = `job-autoapply-finished-${currentRunId || 'none'}`;
  if (store.getItem(finishKey) === '1') {
    sessionStorage.removeItem(PENDING_KEY);
    sessionStorage.removeItem(EXEC_KEY);
    automationActive = false;
    return;
  }
  store.setItem(finishKey, '1');
  safeRuntimeSend({
    type: 'REPORT_AUTOMATION_EVENT',
    payload: { type: 'RUN_SUMMARY', runId: currentRunId, ...counts },
  });
  sessionStorage.removeItem(PENDING_KEY);
  sessionStorage.removeItem(EXEC_KEY);
  automationActive = false;
}

function hasReachedApplyCap(state: NaukriRunState): boolean {
  const cap = state.criteria.dailyApplicationCap;
  // Target = successful applies only. Skips (company-site, already applied, etc.)
  // must not stop the run — keep going until applied hits the cap or Stop is pressed.
  return state.counts.applied >= cap;
}

function buildLinkedInSearchUrl(criteria: SearchCriteria): string {
  const params = new URLSearchParams();
  params.set('keywords', criteria.jobTitles);
  if (criteria.location) params.set('location', criteria.location);
  if (criteria.easyApplyOnly) params.set('f_AL', 'true');
  if (criteria.datePosted === 'Past 24h') params.set('f_TPR', 'r86400');
  if (criteria.datePosted === 'Past week') params.set('f_TPR', 'r604800');
  if (criteria.experienceLevel) {
    const years = Number(criteria.experienceLevel);
    if (Number.isFinite(years)) {
      params.set('f_E', years <= 1 ? '2' : years <= 3 ? '3' : years <= 8 ? '4' : '5');
    }
  }
  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

function toNaukriSlug(value: string | undefined | null): string {
  if (value == null) return '';
  const slug = String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  // Guard against broken bindings that stringify to "undefined" / "null"
  if (!slug || slug === 'undefined' || slug === 'null') return '';
  return slug;
}

/** Naukri location filter uses numeric cityTypeGid (not free-text `l=` alone). */
const NAUKRI_CITY_TYPE_GID: Record<string, string> = {
  bengaluru: '97',
  bangalore: '97',
  hyderabad: '17',
  pune: '139',
  mumbai: '3',
  chennai: '7',
  delhi: '134',
  'new delhi': '134',
  'delhi ncr': '134',
  ncr: '134',
  gurgaon: '8',
  gurugram: '8',
  noida: '220',
  'greater noida': '220',
  kolkata: '9',
  ahmedabad: '10',
  chandigarh: '11',
  jaipur: '12',
  indore: '13',
  lucknow: '14',
  kochi: '15',
  coimbatore: '16',
  remote: '0',
};

function resolveNaukriCityTypeGid(location: string | undefined): string | undefined {
  if (!location) return undefined;
  const primary = location.split(',')[0].trim().toLowerCase();
  if (!primary) return undefined;
  if (/^\d+$/.test(primary)) return primary;
  if (NAUKRI_CITY_TYPE_GID[primary]) return NAUKRI_CITY_TYPE_GID[primary];
  // Partial match: "Noida Sector 62" → noida
  for (const [name, gid] of Object.entries(NAUKRI_CITY_TYPE_GID)) {
    if (primary.includes(name) || name.includes(primary)) return gid;
  }
  return undefined;
}

/** Naukri applies location/experience/freshness only on slug search URLs, not on /jobs?k=... */
function buildNaukriSearchUrl(criteria: SearchCriteria, jobAge?: 1 | 3 | 7): string {
  const params = new URLSearchParams();
  const jobTitles = String(criteria.jobTitles ?? '').trim();
  const primaryLocation = String(criteria.location ?? '').split(',')[0].trim();
  const keywordIsLocation = Boolean(jobTitles)
    && Boolean(primaryLocation)
    && jobTitles.toLowerCase() === primaryLocation.toLowerCase();

  // Repeating the city as the keyword ("noida-jobs-in-noida?k=Noida") makes Naukri fall back to
  // a plain keyword search and drop the location / experience filters.
  const useKeyword = Boolean(jobTitles)
    && jobTitles !== 'undefined'
    && jobTitles !== 'null'
    && !keywordIsLocation;
  if (useKeyword) {
    params.set('k', jobTitles);
  }

  const cityGid = resolveNaukriCityTypeGid(criteria.location);
  if (cityGid) {
    params.set('cityTypeGid', cityGid);
  } else if (primaryLocation && primaryLocation !== 'undefined') {
    // Fallback when city is unknown — still pass text location
    params.set('l', primaryLocation);
  }

  const years = Number(criteria.experienceLevel);
  if (criteria.experienceLevel != null && criteria.experienceLevel !== '' && Number.isFinite(years)) {
    params.set('experience', String(Math.min(Math.max(Math.round(years), 0), 30)));
  }

  // jobAge: optional override for 1 → 3 → 7 widen ladder
  if (jobAge === 1 || jobAge === 3 || jobAge === 7) {
    params.set('jobAge', String(jobAge));
  } else if (criteria.datePosted === 'Past 24h') {
    params.set('jobAge', '1');
  } else if (criteria.datePosted === 'Past week') {
    params.set('jobAge', '7');
  }
  // Any time / unset → omit jobAge

  const titleSlug = useKeyword ? toNaukriSlug(jobTitles.split(',')[0] ?? '') : '';
  const locationSlug = toNaukriSlug(primaryLocation);
  let path = 'jobs';
  if (titleSlug && locationSlug) path = `${titleSlug}-jobs-in-${locationSlug}`;
  else if (titleSlug) path = `${titleSlug}-jobs`;
  else if (locationSlug) path = `jobs-in-${locationSlug}`;

  // Absolute safety: never navigate to /undefined
  if (!path || path === 'undefined' || path.includes('undefined')) {
    path = titleSlug ? `${titleSlug}-jobs` : 'jobs';
  }

  return `https://www.naukri.com/${path}?${params.toString()}`;
}

function resolveNaukriJobAge(state: NaukriRunState): 1 | 3 | 7 | undefined {
  if (state.naukriJobAge === 1 || state.naukriJobAge === 3 || state.naukriJobAge === 7) {
    return state.naukriJobAge;
  }
  if (state.criteria.datePosted === 'Past 24h') return 1;
  if (state.criteria.datePosted === 'Past week') return 7;
  return undefined;
}

function naukriSearchUrlFor(state: NaukriRunState): string {
  return buildNaukriSearchUrl(state.criteria, resolveNaukriJobAge(state));
}

/** Widen jobAge 1 → 3 → 7 when results are exhausted. Returns false when already at 7 (caller should finish). */
function tryWidenNaukriJobAge(state: NaukriRunState): boolean {
  const current = resolveNaukriJobAge(state) ?? 1;
  const next: 1 | 3 | 7 | null = current === 1 ? 3 : current === 3 ? 7 : null;
  if (!next) return false;

  emit({
    status: 'searching',
    reason: `Under target — widening Naukri job age from ${current} to ${next} days...`,
  });
  state.naukriJobAge = next;
  state.criteria = {
    ...state.criteria,
    datePosted: next <= 1 ? 'Past 24h' : 'Past week',
  };
  state.jobIndex = 0;
  // Do NOT clear processedJobKeys — never reopen already handled postings
  saveNaukriState(state);
  releasePageClaim();
  sessionStorage.removeItem(EXEC_KEY);
  window.location.href = buildNaukriSearchUrl(state.criteria, next);
  return true;
}

async function captureNaukriCompanySiteApply(
  state: NaukriRunState,
  jobTitle: string,
  company: string,
  currentUrl: string,
  control: HTMLElement,
): Promise<void> {
  const externalHref = getExternalApplyHref(control);
  const lead: ExternalCompanyLead = {
    jobTitle,
    company,
    naukriUrl: currentUrl,
    skipReason: 'Apply on company site',
    sourceType: 'company-site',
    capturedAt: new Date().toISOString(),
  };

  markJobProcessed(state, currentUrl);
  markJobProcessed(state, state.currentDetailUrl);
  state.counts.skipped++;
  state.jobIndex += 1;
  state.phase = 'list';
  state.jobTitle = undefined;
  state.company = undefined;
  state.currentDetailUrl = undefined;
  saveNaukriState(state);
  releasePageClaim();
  sessionStorage.removeItem(EXEC_KEY);

  emit({
    status: 'searching',
    jobTitle,
    company,
    reason: 'Clicking Apply on company site...',
  });

  // Park the run before the tab opens — a fast capture must not race ahead to the next job
  setExternalPause(state.runId);

  await handleCompanySiteApply(
    state.runId,
    naukriSearchUrlFor(state),
    lead,
    control,
    externalHref,
  );

  if (!control && !isUsableNavigationUrl(externalHref)) {
    recordExternalApplyLead(lead);
    sessionStorage.removeItem(`job-autoapply-external-pending-${state.runId}`);
    clearExternalPause(state.runId);
    window.location.href = naukriSearchUrlFor(state);
    return;
  }

  // Stay parked until the background closes the company tab and returns here
  emit({
    status: 'searching',
    jobTitle,
    company,
    reason: 'Company website opened — waiting to capture link and return before next job...',
  });
}

function isNaukriErrorPage(): boolean {
  if (!window.location.hostname.includes('naukri.com')) return false;
  const path = (window.location.pathname || '').toLowerCase();
  if (path === '/undefined' || path === '/null' || path.includes('/undefined')) return true;
  const bodyText = (document.body?.innerText || '').slice(0, 1200).toLowerCase();
  if (bodyText.includes('error 404') || bodyText.includes('page not found')) return true;
  const title = (document.title || '').toLowerCase();
  return title.includes('404') || title.includes('not found');
}

function isNaukriJobDetailPage(): boolean {
  if (!window.location.hostname.includes('naukri.com')) return false;
  if (isNaukriErrorPage()) return false;
  const path = window.location.pathname.toLowerCase();
  const href = window.location.href.toLowerCase();
  return path.includes('job-listing') || path.includes('job-detail')
    || href.includes('job-listings') || href.includes('job-details');
}

/** Naukri sometimes lands on an unfiltered listing — detect that so we can re-navigate once. */
function naukriFiltersMissing(criteria: SearchCriteria): boolean {
  if (!window.location.hostname.includes('naukri.com')) return false;
  if (isNaukriErrorPage()) return true;

  const flag = `job-autoapply-filter-fix-${currentRunId}`;
  if (sessionStorage.getItem(flag) === '1') return false;

  const expected = new URL(buildNaukriSearchUrl(criteria));
  const current = new URLSearchParams(window.location.search);

  let missing = false;
  for (const key of ['experience', 'jobAge', 'cityTypeGid']) {
    const want = expected.searchParams.get(key);
    if (!want) continue;
    // cityTypeGid may appear multiple times; any match of the desired id is enough
    if (key === 'cityTypeGid') {
      if (!current.getAll('cityTypeGid').includes(want)) missing = true;
    } else if (current.get(key) !== want) {
      missing = true;
    }
  }

  // Also recover when pathname itself is broken (/undefined) even if query looks fine
  const expectedPath = expected.pathname.replace(/\/$/, '') || '/jobs';
  const currentPath = window.location.pathname.replace(/\/$/, '') || '/jobs';
  if (currentPath === '/undefined' || currentPath === '/null') missing = true;
  if (expectedPath !== '/jobs' && currentPath === '/jobs' && expected.searchParams.get('cityTypeGid')) {
    // Prefer slug URL over bare /jobs when filters matter
    missing = true;
  }

  if (missing) sessionStorage.setItem(flag, '1');
  return missing;
}

function isNaukriSearchPage(): boolean {
  if (isNaukriJobDetailPage()) return false;
  if (!window.location.hostname.includes('naukri.com')) return false;
  if (isNaukriErrorPage()) return false;
  const path = window.location.pathname.toLowerCase();
  if (path === '/undefined' || path === '/null') return false;
  if (path.includes('/jobs') || path.includes('-jobs') || path.includes('-job-')) return true;
  // Only treat ?k= as search when path is a real listing route, not a 404 stub
  if (window.location.search.includes('k=') && path !== '/' && !path.includes('undefined')) {
    return true;
  }
  return false;
}

function clearAllRunState(): void {
  sessionStorage.removeItem(PENDING_KEY);
  sessionStorage.removeItem(EXEC_KEY);
  sessionStorage.removeItem(HANDLED_KEY);
  // Keep STOP_KEY so navigations/resumes stay halted until a new run starts
}

/** Clear per-URL open counters so a new run can retry jobs from a previous session. */
function clearNaukriAttemptCounters(): void {
  const toRemove: string[] = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (!key) continue;
    if (
      key.startsWith('job-autoapply-open-count-')
      || key.startsWith('job-autoapply-last-chance-')
      || key.startsWith('job-autoapply-verify-apply-')
      || key.startsWith('job-autoapply-finalized-')
      || key.startsWith('job-autoapply-visited-pages-')
      || key.startsWith('job-autoapply-page-click-')
      || key.startsWith('job-autoapply-list-reload-')
      || key.startsWith('job-autoapply-filter-relax-')
      || key.startsWith('job-autoapply-skip-recorded-')
      || key.startsWith('job-autoapply-bounce-')
      || key.startsWith('job-autoapply-external-tab-open-')
    ) {
      toRemove.push(key);
    }
  }
  for (const key of toRemove) sessionStorage.removeItem(key);
}

function clearStopFlag(): void {
  stopRequested = false;
  sessionStorage.removeItem(STOP_KEY);
  void chrome.storage.local.remove(FORCE_STOP_STORAGE_KEY);
}

function haltAutomationLocally(): void {
  stopRequested = true;
  sessionStorage.setItem(STOP_KEY, '1');
  sessionStorage.removeItem(PENDING_KEY);
  sessionStorage.removeItem(EXEC_KEY);
  sessionStorage.removeItem(HANDLED_KEY);
  sessionStorage.removeItem('job-autoapply-naukri-profile-update');
  clearExternalPause();
  automationActive = false;
}

// Keep stop in sync with background (works even when tab message is delayed)
try {
  chrome.storage.local.get(FORCE_STOP_STORAGE_KEY, (stored) => {
    const epoch = Number(stored[FORCE_STOP_STORAGE_KEY] || 0);
    if (epoch > forceStopEpoch) {
      forceStopEpoch = epoch;
      haltAutomationLocally();
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[FORCE_STOP_STORAGE_KEY]) return;
    const epoch = Number(changes[FORCE_STOP_STORAGE_KEY].newValue || 0);
    if (epoch > forceStopEpoch) {
      forceStopEpoch = epoch;
      haltAutomationLocally();
    }
  });
} catch {
  // storage may be unavailable in some test contexts
}

function getJobDetailUrl(card: HTMLElement): string | null {
  const link = card.querySelector(
    'a.title, a[href*="job-listings"], a[href*="job-details"], .title a, h2 a',
  ) as HTMLAnchorElement | null;
  if (!link?.href) return null;
  const href = link.href.trim();
  if (!href || href === 'undefined' || href.endsWith('/undefined')) return null;
  try {
    const url = new URL(href, window.location.origin);
    if (url.pathname.toLowerCase().includes('/undefined')) return null;
    if (!(url.href.includes('job-listings') || url.href.includes('job-details'))) return null;
    return url.href;
  } catch {
    return null;
  }
}

async function waitForNaukriJobCards(timeoutMs = 20000): Promise<HTMLElement[]> {
  const selectors = [
    '.srp-jobtuple-wrapper',
    '[class*="jobTuple"]',
    '[class*="job-tuple"]',
    '.cust-job-tuple',
    'article.jobTuple',
  ];

  const start = Date.now();
  while (Date.now() - start < timeoutMs && !isStopped()) {
    if (isNaukriErrorPage()) return [];
    for (const sel of selectors) {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(sel));
      if (nodes.length > 0) return nodes;
    }

    await sleep(800);
  }
  return [];
}

function isNaukriListLoading(): boolean {
  if (document.querySelectorAll('.srp-jobtuple-wrapper, [class*="jobTuple"], .cust-job-tuple').length > 0) {
    return false;
  }
  const text = (document.body?.innerText || '').slice(0, 500).toLowerCase();
  if (text.includes('no jobs found') || text.includes('did not match any jobs')) return false;
  // Naukri full-page loader (purple logo + dots) leaves almost no job chrome
  const hasLoaderDots = document.querySelectorAll('[class*="loader"], [class*="Loading"], .naukri-loader').length > 0;
  const sparseDom = document.querySelectorAll('a[href*="job-listings"]').length === 0;
  return hasLoaderDots || sparseDom;
}

function findNaukriNextPageTarget(): HTMLElement | HTMLAnchorElement | null {
  // Prefer explicit pagination controls only — broad ".next" matches caused fake page advances
  const selectors = [
    'a[aria-label="Next"]',
    'a[aria-label*="Next Page" i]',
    'a[title="Next"]',
    'div.pagination a.fright',
    'a[href*="page="]',
    '.pagination a',
  ];

  for (const sel of selectors) {
    try {
      for (const el of document.querySelectorAll<HTMLElement>(sel)) {
        if (!isVisible(el)) continue;
        const text = normalizeText(el.textContent ?? el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '');
        const rel = (el.getAttribute('rel') || '').toLowerCase();
        if (rel === 'next' || text === 'next' || text.includes('next')) {
          if ((el as HTMLAnchorElement).href?.includes('javascript:')) continue;
          return el as HTMLElement | HTMLAnchorElement;
        }
      }
    } catch {
      // ignore invalid selector
    }
  }
  return null;
}

function goToNextNaukriResultsPage(state: NaukriRunState): boolean {
  const next = findNaukriNextPageTarget();
  if (!next) return false;

  const currentUrl = normalizeJobUrl(window.location.href);
  const visitedKey = `job-autoapply-visited-pages-${state.runId}`;
  const visited = new Set<string>(JSON.parse(sessionStorage.getItem(visitedKey) || '[]'));
  visited.add(currentUrl);

  const href = (next as HTMLAnchorElement).href;
  if (href) {
    try {
      const nextUrl = normalizeJobUrl(new URL(href, window.location.origin).href);
      if (visited.has(nextUrl) || nextUrl === currentUrl) {
        return false;
      }
      visited.add(nextUrl);
      sessionStorage.setItem(visitedKey, JSON.stringify([...visited]));
      state.phase = 'list';
      state.jobIndex = 0;
      saveNaukriState(state);
      releasePageClaim();
      sessionStorage.removeItem(EXEC_KEY);
      window.location.href = href;
      return true;
    } catch {
      // fall through to click
    }
  }

  const pageAttemptsKey = `job-autoapply-page-click-${state.runId}-${currentUrl}`;
  const clicks = Number(sessionStorage.getItem(pageAttemptsKey) || '0');
  if (clicks >= 1) return false;
  sessionStorage.setItem(pageAttemptsKey, String(clicks + 1));
  sessionStorage.setItem(visitedKey, JSON.stringify([...visited]));

  state.phase = 'list';
  state.jobIndex = 0;
  saveNaukriState(state);
  releasePageClaim();
  sessionStorage.removeItem(EXEC_KEY);
  forceClick(next);
  return true;
}

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isExternalApplyText(text: string): boolean {
  return isExternalApplyLabel(text)
    || text.includes('company site')
    || text.includes('company website')
    || text.includes('on company');
}

function isApplyLabel(text: string): boolean {
  const t = normalizeText(text);
  if (!t || isExternalApplyLabel(t) || isExternalApplyText(t)) return false;
  return t === 'apply' || t === 'apply now' || t === 'quick apply' || t.startsWith('apply ');
}

function isApplyButtonElement(el: HTMLElement): boolean {
  const text = normalizeText(el.textContent ?? el.getAttribute('aria-label') ?? '');
  return isApplyLabel(text) && !isExternalApplyLabel(text);
}

function findApplyNearSave(): HTMLElement | null {
  const saves = Array.from(document.querySelectorAll<HTMLElement>('button, a, [role="button"]')).filter(
    (el) => isVisible(el) && normalizeText(el.textContent ?? '') === 'save',
  );
  for (const save of saves) {
    const rect = save.getBoundingClientRect();
    if (rect.top > window.innerHeight * 0.5) continue;
    const container = save.parentElement;
    if (!container) continue;
    const apply = Array.from(container.querySelectorAll<HTMLElement>('button, a, [role="button"]')).find(
      (el) => el !== save && isVisible(el) && isApplyButtonElement(el),
    );
    if (apply) return apply;
  }
  return null;
}

function findNaukriApplyButtonSync(): HTMLElement | null {
  const byId = document.querySelector('#apply-button, button#apply-button, #walkin-button') as HTMLElement | null;
  // #apply-button is often the company-website CTA — never treat that as Naukri Easy Apply
  if (byId && isVisible(byId) && !isExternalApplyLabel(getElementText(byId))) return byId;

  const nearSave = findApplyNearSave();
  if (nearSave) return nearSave;

  const headerCandidates: HTMLElement[] = [];
  document.querySelectorAll<HTMLElement>('button, a, [role="button"]').forEach((el) => {
    if (!isVisible(el) || !isApplyButtonElement(el)) return;
    if (isExternalApplyLabel(getElementText(el))) return;
    const rect = el.getBoundingClientRect();
    if (rect.top > window.innerHeight * 0.5 || rect.width < 30 || rect.height < 20) return;
    headerCandidates.push(el);
  });
  if (headerCandidates.length > 0) {
    headerCandidates.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return headerCandidates[0];
  }

  const fallback = findApplyControl(document);
  if (fallback && isExternalApplyLabel(getElementText(fallback))) return null;
  return fallback;
}

function isApplyButtonStillOnPage(): boolean {
  return findNaukriApplyButtonSync() !== null;
}

/** Primary Naukri Apply control flipped to Applied (simple apply success on same page). */
function naukriPrimaryApplyLooksApplied(): boolean {
  const nodes: HTMLElement[] = [];
  const byId = document.querySelector<HTMLElement>('#apply-button, button#apply-button, #walkin-button');
  if (byId) nodes.push(byId);
  document.querySelectorAll<HTMLElement>('button, a, [role="button"]').forEach((el) => {
    if (!isVisible(el)) return;
    const rect = el.getBoundingClientRect();
    if (rect.top > window.innerHeight * 0.55 || rect.width < 30) return;
    nodes.push(el);
  });

  for (const el of nodes) {
    const text = normalizeText(el.textContent ?? el.getAttribute('aria-label') ?? '');
    const cls = `${el.className || ''} ${el.getAttribute('class') || ''}`.toLowerCase();
    if (text === 'applied' || text === 'applied successfully' || text.startsWith('applied ')) return true;
    if (/\bapplied\b/.test(cls) && !isApplyLabel(text)) return true;
    if ((el.getAttribute('aria-disabled') === 'true' || (el instanceof HTMLButtonElement && el.disabled))
      && /applied|success/i.test(text || cls)) {
      return true;
    }
  }
  return false;
}

function detectApplyClickWorked(): boolean {
  return detectNaukriApplySuccess()
    || isAlreadyAppliedOnPage()
    || headerShowsAppliedBadge()
    || naukriPrimaryApplyLooksApplied()
    || pageHasRecruiterChatbot()
    || Boolean(getNaukriQuestionModal())
    || Boolean(findNaukriChatInput(document))
    || hasVisibleApplyDialog();
}

function hasVisibleApplyDialog(): boolean {
  for (const node of document.querySelectorAll('[role="dialog"]')) {
    const el = node as HTMLElement;
    if (!isVisible(el)) continue;
    if (el.querySelector('input[type="radio"]') && findModalActionButton(el)) return true;
    const text = (el.textContent ?? '').toLowerCase();
    if (text.includes('type message') || text.includes('recruiter') || text.includes('kindly answer')) return true;
  }
  return false;
}

function forceClick(el: HTMLElement): void {
  el.scrollIntoView({ block: 'center', behavior: 'instant' });

  let target: HTMLElement = el;
  if (el.id === 'apply-button' || el.id === 'walkin-button') {
    target = el;
  } else if (el.tagName !== 'BUTTON' && el.tagName !== 'A') {
    const innerBtn = el.querySelector('button, a') as HTMLElement | null;
    const closestBtn = el.closest('button, a, [role="button"]') as HTMLElement | null;
    target = innerBtn ?? closestBtn ?? el;
  }

  if (target instanceof HTMLButtonElement) {
    target.disabled = false;
    target.removeAttribute('disabled');
  }
  target.removeAttribute('aria-disabled');
  target.classList.remove('disabled');

  const rect = target.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  const opts: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    composed: true,
    clientX,
    clientY,
    button: 0,
    buttons: 1,
  };
  target.focus({ preventScroll: true });
  try {
    target.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }));
    target.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse' }));
  } catch {
    // PointerEvent may be unavailable in some contexts
  }
  target.dispatchEvent(new MouseEvent('mousedown', opts));
  target.dispatchEvent(new MouseEvent('mouseup', opts));
  target.dispatchEvent(new MouseEvent('click', opts));
  target.click();
}

function clickElementCenter(el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const centerTarget = document.elementFromPoint(x, y) as HTMLElement | null;
  forceClick(centerTarget ?? el);
}

async function clickNaukriApplyViaMainWorld(): Promise<boolean> {
  const res = await sendRuntimeMessage<{ ok?: boolean; clicked?: boolean; trusted?: boolean }>(
    { type: 'CLICK_NAUKRI_APPLY' },
    10000,
  );
  return Boolean(res?.ok && res?.clicked);
}

type ApplyClickResult = 'worked' | 'site-error' | 'failed';

function dismissBlockingNaukriOverlaysBeforeApply(): void {
  // Recruiter chat already open — nothing here may run, every click would close it
  if (isNaukriChatOpen()) return;

  // Cookie / consent bars
  document.querySelectorAll<HTMLElement>(
    'button, a, [role="button"]',
  ).forEach((el) => {
    if (!isVisible(el)) return;
    const t = normalizeText(el.textContent ?? '');
    if (!/^(accept|accept all|got it|ok|allow|agree|i agree|close)$/i.test(t) && !/^accept /.test(t)) return;
    const near = normalizeText((el.closest('[class*="cookie"], [id*="cookie"], [class*="consent"], [class*="banner"]')?.textContent || '').slice(0, 200));
    if (near.includes('cookie') || near.includes('consent') || t === 'got it' || t === 'accept all') {
      forceClick(el);
    }
  });
  // Non-apply dialogs that sit on top of Apply
  for (const dialog of document.querySelectorAll<HTMLElement>('[role="dialog"], [class*="modal" i]')) {
    if (!isVisible(dialog)) continue;
    const text = normalizeText(dialog.innerText || '').slice(0, 400);
    if (/apply|recruiter|type message|years of|ctc|resid/i.test(text)) continue;
    if (/cookie|consent|notification|login|otp|verify|subscribe|download app/i.test(text)) {
      const close = dialog.querySelector<HTMLElement>(
        'button[aria-label*="close" i], button[aria-label*="dismiss" i], button.close, [class*="close"]',
      );
      if (close) forceClick(close);
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
  }
}

/** Naukri pages that are not a job posting — retrying Apply there can only fail. */
function isOffJobPostingPage(): boolean {
  const url = window.location.href.toLowerCase();
  return /\/(jobalert|alerts?|mnjuser|myapply\/alert|recruiter|companies|services)\b/.test(url)
    || /createjobalert|job-alert/.test(url);
}

async function clickNaukriApplyButton(btn: HTMLElement): Promise<ApplyClickResult> {
  if (detectNaukriSiteError()) return 'site-error';
  if (isOffJobPostingPage()) {
    emit({ status: 'searching', reason: 'Not on the job posting — skipping Apply clicks' });
    return 'failed';
  }

  // Chat already open — clicking Apply behind it closes the chat and loses the answers
  if (isNaukriChatOpen()) {
    emit({ status: 'searching', reason: 'Questions already open — not re-clicking Apply' });
    return 'worked';
  }

  dismissBlockingNaukriOverlaysBeforeApply();
  await sleep(600);

  // Prefer MAIN-world + CDP trusted click first — isolated-world clicks often never apply
  emit({ status: 'searching', reason: 'Clicking Apply (page + trusted click)...' });
  await clickNaukriApplyViaMainWorld();
  await sleep(1200);
  if (detectNaukriSiteError()) return 'site-error';
  if (detectApplyClickWorked() || naukriPrimaryApplyLooksApplied()) return 'worked';

  // Isolated-world retries as backup
  for (let attempt = 0; attempt < 3 && !isStopped(); attempt++) {
    if (detectNaukriSiteError()) return 'site-error';
    if (isOffJobPostingPage()) return 'failed';

    const fresh = findNaukriApplyButtonSync() ?? btn;
    emit({ status: 'searching', reason: `Retrying Apply click (${attempt + 1}/3)...` });
    fresh.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(200);
    forceClick(fresh);
    await sleep(900);

    if (detectNaukriSiteError()) return 'site-error';
    if (detectApplyClickWorked() || naukriPrimaryApplyLooksApplied()) return 'worked';
  }

  // Second trusted click pass
  emit({ status: 'searching', reason: 'Apply click — second trusted attempt...' });
  await clickNaukriApplyViaMainWorld();
  await sleep(1500);
  if (detectNaukriSiteError()) return 'site-error';
  if (detectApplyClickWorked() || naukriPrimaryApplyLooksApplied()) return 'worked';

  const waitStart = Date.now();
  while (Date.now() - waitStart < 4000 && !isStopped()) {
    if (detectNaukriSiteError()) return 'site-error';
    if (detectApplyClickWorked() || naukriPrimaryApplyLooksApplied()) return 'worked';
    await sleep(300);
  }

  if (detectNaukriSiteError()) return 'site-error';
  // Only treat missing Apply as success if Applied badge/toast is also present
  if (!isApplyButtonStillOnPage() && (naukriPrimaryApplyLooksApplied() || headerShowsAppliedBadge() || detectNaukriApplySuccess())) {
    return 'worked';
  }
  return 'failed';
}

function pickBestApplyButton(buttons: HTMLElement[]): HTMLElement | null {
  const filtered = buttons.filter((el) => {
    const text = normalizeText(el.textContent ?? '');
    if (isExternalApplyText(text)) return false;
    const rect = el.getBoundingClientRect();
    // Keep header/top apply CTAs; ignore footer junk
    if (rect.top > window.innerHeight * 0.75) return false;
    return true;
  });
  if (filtered.length === 0) return null;
  const byId = filtered.find((el) => el.id === 'apply-button' || el.id === 'walkin-button');
  if (byId) return byId;
  filtered.sort((a, b) => {
    const score = (el: HTMLElement) => {
      let s = 0;
      const cls = (el.className?.toString() ?? '').toLowerCase();
      if (cls.includes('apply')) s += 80;
      const text = normalizeText(el.textContent ?? '');
      if (text === 'apply' || text === 'apply now') s += 40;
      s -= Math.round(el.getBoundingClientRect().top);
      return s;
    };
    return score(b) - score(a);
  });
  return filtered[0];
}

function findApplyControl(root: ParentNode): HTMLElement | null {
  const prioritySelectors = [
    '#apply-button',
    'button#apply-button',
    '#walkin-button',
    'button#walkin-button',
    '.apply-button',
    '.btn-apply',
    '[id*="apply-button"]',
    'button[class*="apply"]',
    'a[class*="apply"]',
    '[class*="btn-apply"]',
    '[class*="ApplyButton"]',
  ];

  const priorityMatches: HTMLElement[] = [];
  for (const sel of prioritySelectors) {
    root.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      if (isVisible(el)) priorityMatches.push(el);
    });
  }
  root.querySelectorAll<HTMLElement>('[aria-label]').forEach((el) => {
    if (!isVisible(el)) return;
    const aria = (el.getAttribute('aria-label') ?? '').toLowerCase();
    if (aria.includes('apply') && !aria.includes('company')) priorityMatches.push(el);
  });
  const bestPriority = pickBestApplyButton(priorityMatches);
  if (bestPriority) return bestPriority;

  const textMatches: HTMLElement[] = [];
  root.querySelectorAll<HTMLElement>('button, a, div, span, [role="button"]').forEach((el) => {
    if (!isVisible(el)) return;
    const text = normalizeText(el.textContent ?? '');
    if (isApplyLabel(text)) textMatches.push(el);
  });
  return pickBestApplyButton(textMatches);
}

async function waitForNaukriApplyButton(timeoutMs = 8000): Promise<HTMLElement | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs && !isStopped()) {
    const btn = findNaukriApplyButtonSync();
    if (btn) return btn;
    await sleep(100);
  }
  return null;
}

function setReactInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  if ((input as HTMLInputElement).type === 'file') return;
  try {
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const coerced = coerceAnswerForInput(input, value);
    if (setter) setter.call(input, coerced);
    else input.value = coerced;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } catch {
    // Some Naukri inputs (e.g. file) reject programmatic values
  }
}

function isChatInputElement(el: HTMLElement): boolean {
  const ph = (el as HTMLInputElement).placeholder?.toLowerCase() ?? '';
  const aria = el.getAttribute('aria-label')?.toLowerCase() ?? '';
  const cls = (el.className?.toString() ?? '').toLowerCase();
  const name = ((el as HTMLInputElement).name ?? '').toLowerCase();
  const id = (el.id ?? '').toLowerCase();
  const dataPlaceholder = (el.getAttribute('data-placeholder') ?? '').toLowerCase();
  return ph.includes('type messag')
    || ph.includes('type message')
    || ph.includes('message here')
    || ph.includes('type here')
    || ph.includes('type your')
    || dataPlaceholder.includes('message')
    || dataPlaceholder.includes('type')
    || aria.includes('message')
    || cls.includes('chatinput')
    || cls.includes('chat-input')
    || cls.includes('message-input')
    || name.includes('message')
    || id.includes('message')
    || id.includes('chat');
}

function findChatInputInRoot(root: ParentNode): HTMLElement | null {
  const softVisible = (el: HTMLElement): boolean => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    // Don't require a non-zero rect — Naukri sometimes mounts the input at 0 briefly
    return true;
  };

  const candidates = root.querySelectorAll<HTMLElement>(
    'input[type="text"], input:not([type]), input[type="search"], textarea, [contenteditable="true"], [contenteditable=""]',
  );

  for (const el of candidates) {
    if (!softVisible(el)) continue;
    if (isNonRecruiterNaukriWidget(el)) continue;
    if (isChatInputElement(el)) return el;
  }

  // Bot / dialog containers — include notice/ctc questions (not only experience)
  const containers = root.querySelectorAll<HTMLElement>(
    '[class*="chatbot"], [class*="Chatbot"], [class*="NaukriWBot"], [class*="botContainer"], [class*="bot-container"], [class*="botMsg"], [role="dialog"], [class*="modal"], [class*="Modal"]',
  );
  for (const container of containers) {
    if (container instanceof HTMLElement && !softVisible(container)) continue;
    const text = (container.textContent ?? '').toLowerCase();
    if (isNaukriPromoWidgetText(text)) continue;
    if (
      !text.includes('type message')
      && !text.includes('recruiter')
      && !text.includes('notice')
      && !text.includes('ctc')
      && !text.includes('years')
      && !text.includes('experience')
      && !text.includes('kindly answer')
    ) {
      continue;
    }
    for (const el of container.querySelectorAll<HTMLElement>(
      'input[type="text"], input:not([type]), input[type="search"], textarea, [contenteditable="true"], [contenteditable=""]',
    )) {
      if ((el as HTMLInputElement).type === 'file' || (el as HTMLInputElement).type === 'hidden') continue;
      if (!softVisible(el)) continue;
      return el;
    }
  }

  // Visible empty text field sitting next to a Save button — only when the surrounding
  // text actually reads like a recruiter question, otherwise Naukri's job-alert email box
  // (which sits beside the listing's Save/bookmark button) gets answered by mistake.
  for (const el of candidates) {
    if (!softVisible(el)) continue;
    if ((el as HTMLInputElement).type === 'file') continue;
    if (isNonRecruiterNaukriWidget(el)) continue;
    const parent = el.closest('div, form, section, aside, [role="dialog"]');
    if (!parent) continue;
    const parentText = ((parent as HTMLElement).innerText ?? '').toLowerCase();
    if (isNaukriPromoWidgetText(parentText)) continue;
    if (!/recruiter|kindly answer|type message|experi|notice|ctc|salary|relocat|skip this question/.test(parentText)) {
      continue;
    }
    for (const btn of parent.querySelectorAll<HTMLElement>('button, [role="button"]')) {
      if (isJobBookmarkSaveControl(btn)) continue;
      const saveText = normalizeText(btn.textContent ?? '');
      if (saveText === 'save' || saveText === 'send' || saveText === 'submit') return el;
    }
  }
  return null;
}

function findNaukriChatInput(root: ParentNode = document): HTMLElement | null {
  const direct = findChatInputInRoot(root);
  if (direct) return direct;

  if (root === document || root === document.documentElement || root === document.body) {
    for (const iframe of document.querySelectorAll('iframe')) {
      try {
        const doc = iframe.contentDocument;
        if (!doc) continue;
        const found = findChatInputInRoot(doc);
        if (found) return found;
      } catch {
        // cross-origin iframe
      }
    }
  }
  return null;
}

function pageHasRecruiterChatbot(): boolean {
  if (hasGenuineRecruiterChat()) return true;
  const text = document.body?.innerText?.toLowerCase() ?? '';
  // Body text alone is too noisy (JD mentions "recruiter"); require chat chrome phrases
  return text.includes('type message here')
    || text.includes("recruiter's questions")
    || text.includes('recruiters questions')
    || text.includes('kindly answer all the recruiter')
    || (text.includes('skip this question') && text.includes('type message'));
}

/**
 * The recruiter chat/question modal while it is actually on screen.
 * Any click outside this element closes the chat and Naukri then rejects the
 * application as "incomplete", so every click path must check against it.
 */
function getOpenNaukriChatContainer(): HTMLElement | null {
  const chat = findNaukriChatbotContainer();
  if (chat && isVisible(chat)) return chat;
  const modal = getNaukriQuestionModal();
  if (modal instanceof HTMLElement && isVisible(modal)) return modal;
  // No fallback to "any input's ancestor": on a plain job page that resolved to the
  // listing card, and the run then answered the job title as if it were a question.
  const input = findNaukriChatInput(document);
  if (input && isInsideGenuineNaukriChatbot(input)) {
    const scope = getChatbotScopeFromInput(input);
    if (scope instanceof HTMLElement && isVisible(scope)) return scope;
  }
  return null;
}

function isNaukriChatOpen(): boolean {
  return Boolean(getOpenNaukriChatContainer());
}

/**
 * True only for a real recruiter Q&A modal. A bare text input on the job page (Naukri's
 * job-alert box, search field) must not count, or the run answers the wrong form.
 */
function hasGenuineRecruiterChat(): boolean {
  const chat = getOpenNaukriChatContainer();
  if (!chat) return false;
  const text = (chat.innerText || '').slice(0, 3000);
  if (isNaukriPromoWidgetText(text)) return false;
  // Must be a real chatbot panel OR show classic recruiter-chat chrome
  const hasChatChrome = isInsideGenuineNaukriChatbot(chat)
    || containerLooksLikeRecruiterChat(text)
    || Boolean(chat.querySelector?.('.chatbot_NaukriWBot, [class*="NaukriWBot"], [class*="botContainer"]'));
  if (!hasChatChrome) return false;
  if (containerLooksLikeRecruiterChat(text)) return true;
  const question = extractRecruiterQuestionFromPage(chat);
  return Boolean(question && !isNaukriJobDescriptionText(question));
}

/** Close Naukri's profile / account drawer if it was opened by a stray click. */
function dismissNaukriProfileDrawer(): void {
  const drawers = document.querySelectorAll<HTMLElement>(
    '[class*="drawer" i], [class*="nI-gNb" i], [role="dialog"], [class*="profile" i]',
  );
  for (const el of drawers) {
    if (!isVisible(el)) continue;
    const text = (el.innerText || '').slice(0, 800);
    if (!/view (?:&|and) update profile|upgrade to naukri pro|search appearances|recruiter actions|naukri blog/i.test(text)) {
      continue;
    }
    const closeBtn = el.querySelector<HTMLElement>(
      'button[aria-label*="close" i], [class*="close" i], [data-testid*="close" i], button',
    );
    // Prefer an X / close control; otherwise press Escape
    if (closeBtn && /close|×|✕/i.test(`${closeBtn.getAttribute('aria-label') || ''} ${closeBtn.textContent || ''}`)) {
      forceClick(closeBtn);
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));
    }
    return;
  }
}

function isInsideNaukriChat(el: Element | null | undefined): boolean {
  if (!el) return false;
  const chat = getOpenNaukriChatContainer();
  return Boolean(chat && (chat === el || chat.contains(el)));
}

/** Job listings carry their own Save (bookmark) button next to Apply — never click it in chat flows. */
function isJobBookmarkSaveControl(el: HTMLElement): boolean {
  const meta = normalizeText(
    [el.getAttribute('aria-label'), el.getAttribute('title'), el.className?.toString()]
      .filter(Boolean)
      .join(' '),
  );
  if (meta.includes('save job') || meta.includes('savejob') || meta.includes('bookmark')) return true;
  const text = normalizeText(el.textContent ?? '');
  if (text === 'saved') return true;
  return Boolean(
    el.closest('#apply-button, [class*="apply-button" i], [class*="jhc__btn" i], [class*="save-job" i]'),
  );
}

/** Ask background to type+Save in MAIN world (all frames) — bypasses React controlled-input issues. */
async function answerNaukriChatViaMainWorld(answer: string, questionHint?: string): Promise<boolean> {
  const res = await sendRuntimeMessage<{ ok?: boolean; answered?: boolean }>({
    type: 'ANSWER_NAUKRI_CHAT',
    payload: { answer, questionHint: questionHint ?? '' },
  }, 6000);
  return Boolean(res?.ok && res?.answered);
}

/** Content-script typing path — used when the MAIN-world injection is unavailable or times out. */
async function answerNaukriChatDirect(
  answer: string,
  jobTitle?: string,
  company?: string,
): Promise<boolean> {
  // Never type when Yes/No or real choice options are on screen
  const container = findNaukriChatbotContainer() ?? document.body;
  const visibleOptions = collectNaukriChoiceOptions(container);
  if (hasRealSelectableChoices(visibleOptions, '', findNaukriChatInput(document))) {
    emit({
      status: 'searching',
      jobTitle,
      company,
      reason: 'Options visible — skipping chat typing',
    });
    return false;
  }

  const input = findNaukriChatInput(document);
  if (!input) return false;
  if (isNonRecruiterNaukriWidget(input)) return false;

  emit({ status: 'searching', jobTitle, company, reason: `Typing into chat: ${answer}` });

  // Always overwrite — don't assume an empty check; React may show empty while value is stale
  input.focus();
  input.click();
  await sleep(100);
  setEditableValue(input, answer);
  await sleep(200);
  if (!getInputValue(input)) {
    setReactInputValue(input as HTMLInputElement, answer);
    await sleep(200);
  }
  if (!getInputValue(input)) {
    // Last resort: character-by-character InputEvents
    try {
      const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(input, '');
      else (input as HTMLInputElement).value = '';
      for (const ch of answer) {
        const next = `${(input as HTMLInputElement).value}${ch}`;
        if (setter) setter.call(input, next);
        else (input as HTMLInputElement).value = next;
        input.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          data: ch,
          inputType: 'insertText',
        }));
      }
    } catch {
      // ignore
    }
    await sleep(150);
  }

  if (!getInputValue(input)) {
    emit({ status: 'searching', jobTitle, company, reason: 'Chat input refused the typed value' });
    return false;
  }

  const scope = getChatbotScopeFromInput(input);

  // Save (force-enables the disabled Save button), then Enter/submit as backup
  await clickNaukriSaveButton(scope, jobTitle, company);
  await sleep(300);
  if (detectNaukriApplySuccess()) return true;
  if (getInputValue(input)) {
    await submitChatAnswer(scope, input, jobTitle, company);
  }

  // Submitted if the input cleared or the chat produced a fresh question
  return !getInputValue(input) || detectNaukriApplySuccess();
}

function isNaukriMessengerChat(scope: ParentNode): boolean {
  const input = findNaukriChatInput(scope) ?? findNaukriChatInput(document);
  return Boolean(input && isChatInputElement(input));
}

function isNaukriFormQuestionModal(scope: ParentNode): boolean {
  if (isNaukriMessengerChat(scope)) return false;
  const hasFields = scope.querySelector(
    'input:not([type="hidden"]):not([type="file"]), select, textarea, input[type="checkbox"], input[type="radio"]',
  );
  const hasAction = findModalActionButton(scope);
  return Boolean(hasFields && hasAction);
}

function getChatbotScopeFromInput(input: HTMLElement): ParentNode {
  const dialog = input.closest<HTMLElement>(
    '[role="dialog"], .chatbot_NaukriWBot, .botContainer, [class*="NaukriWBot"], [class*="chatbot"], [class*="Chatbot"], [class*="modal"], [class*="Modal"], [class*="drawer"], [class*="overlay"]',
  );
  if (dialog) return dialog;

  // Prefer the nearest ancestor that actually contains recruiter questions
  let best: HTMLElement | null = null;
  let el: HTMLElement | null = input.parentElement;
  for (let i = 0; i < 14 && el; i++, el = el.parentElement) {
    const text = el.innerText ?? '';
    if (text.includes('?') && text.length > 20 && text.length < 20000) {
      best = el;
    }
    if (el.getAttribute('role') === 'dialog') return el;
  }
  return best
    ?? input.closest('aside, [class*="panel"], [class*="drawer"]')
    ?? input.parentElement?.parentElement
    ?? input.parentElement
    ?? document;
}

function getInputValue(el: HTMLElement): string {
  if (el.getAttribute('contenteditable') != null) return el.textContent?.trim() ?? '';
  return (el as HTMLInputElement).value?.trim() ?? '';
}

function setEditableValue(el: HTMLElement, value: string): void {
  if (el.getAttribute('contenteditable') != null) {
    el.focus();
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  typeIntoReactChatInput(el as HTMLInputElement | HTMLTextAreaElement, value);
}

/** Naukri chat Save stays disabled unless React sees a real input stream. */
function typeIntoReactChatInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  if ((input as HTMLInputElement).type === 'file') return;
  input.scrollIntoView({ block: 'center', behavior: 'instant' });
  input.focus();
  input.click();

  try {
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(input, '');
    else input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } catch {
    // ignore
  }

  let inserted = false;
  try {
    inserted = document.execCommand('insertText', false, value);
  } catch {
    inserted = false;
  }

  if (!inserted || !input.value) {
    try {
      const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(input, value);
      else input.value = value;
    } catch {
      input.value = value;
    }
  }

  input.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    cancelable: true,
    data: value,
    inputType: 'insertText',
  }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
}

function pressEnter(el: HTMLElement): void {
  el.focus();
  const opts: KeyboardEventInit = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keypress', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
}

function pressEnterOnModal(scope: ParentNode): void {
  const dialog = findVisibleDialogForScope(scope);
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const target = focused && dialog?.contains(focused) ? focused : dialog ?? document.body;
  pressEnter(target);
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  }));
}

function findChatSendControl(chatInput: HTMLElement, scope: ParentNode): HTMLElement | null {
  const roots: ParentNode[] = [];
  const add = (node: ParentNode | null | undefined) => {
    if (node && !roots.includes(node)) roots.push(node);
  };
  add(chatInput.parentElement);
  add(chatInput.parentElement?.parentElement);
  add(chatInput.closest('form'));
  add(chatInput.closest('[class*="footer"]'));
  add(chatInput.closest('[class*="Footer"]'));
  add(chatInput.closest('[class*="input"]'));
  add(chatInput.closest('[class*="chat"]'));
  add(scope);

  const chatOpen = isNaukriChatOpen();

  for (const root of roots) {
    const fromHelper = findChatbotSendButton(root, chatInput);
    if (fromHelper) return fromHelper;

    for (const el of root.querySelectorAll<HTMLElement>('button, [role="button"], a, span, div, i')) {
      if (!isVisible(el)) continue;
      if (isPromoActionControl(el)) continue;
      if (chatOpen && !isInsideNaukriChat(el)) continue;
      const cls = (el.className?.toString() ?? '').toLowerCase();
      const aria = (el.getAttribute('aria-label') ?? '').toLowerCase();
      const title = (el.getAttribute('title') ?? '').toLowerCase();
      const hasSendIcon = Boolean(el.querySelector('svg, [class*="send"], [class*="Send"], img'));
      if (
        cls.includes('send')
        || aria.includes('send')
        || title.includes('send')
        || (hasSendIcon && el.closest('[class*="footer"], [class*="input"], [class*="chat"]'))
      ) {
        const clickable = (el.closest('button, a, [role="button"]') as HTMLElement | null) ?? el;
        if (isVisible(clickable) && !isPromoActionControl(clickable)) return clickable;
      }
    }

    const save = findModalActionButton(root);
    if (save) return save;
  }
  return null;
}

async function submitChatAnswer(
  scope: ParentNode,
  chatInput: HTMLElement,
  jobTitle?: string,
  company?: string,
): Promise<boolean> {
  if (!getInputValue(chatInput)) return false;

  emit({ status: 'searching', jobTitle, company, reason: 'Submitting chat answer...' });

  for (let attempt = 0; attempt < 4; attempt++) {
    const sendBtn = findChatSendControl(chatInput, scope);
    if (sendBtn) {
      emit({ status: 'searching', jobTitle, company, reason: `Clicking ${sendBtn.textContent?.trim() || 'Send'}...` });
      forceClick(sendBtn);
      await sleep(700);
      if (detectNaukriApplySuccess()) return true;
      if (!getInputValue(chatInput)) return true;
    }

    chatInput.focus();
    pressEnter(chatInput);
    await sleep(700);
    if (detectNaukriApplySuccess()) return true;
    if (!getInputValue(chatInput)) return true;

    const form = chatInput.closest('form');
    if (form) {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await sleep(700);
      if (!getInputValue(chatInput)) return true;
    }
  }
  return false;
}

function getModalQuestionText(scope: ParentNode): string {
  const fromChat = getLastChatbotQuestion(scope);
  if (fromChat) return fromChat;

  for (const sel of ['[class*="question"]', '[class*="Question"]', 'h1', 'h2', 'h3', 'h4', 'p', 'label']) {
    for (const el of scope.querySelectorAll<HTMLElement>(sel)) {
      const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t.includes('?') && t.length > 10 && t.length < 400) return t;
    }
  }
  return '';
}

function isOurChatAnswerLine(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  // Prior answers we typed (and short recruiter acknowledgements)
  if (/^(yes|no|ok|okay|sure|immediate|na|n\/a)[.!]?$/i.test(t)) return true;
  if (/^\d+(\.\d+)?\s*(years?|yrs?|lacs?|lakhs?|lpa|%|days?)?$/i.test(t)) return true;
  if (t.length <= 40 && !t.includes('?') && !/^(how|what|where|which|are|do|have|will|can|rate|please|enter)/i.test(t)) {
    // Likely a short free-text answer (location, skill list fragment, etc.)
    if (/^(javascript|typescript|react|node|java|python|php)/i.test(t)) return true;
  }
  return false;
}

/**
 * Naukri's own widgets (job alerts, "Send me jobs like this", profile menu, search) also
 * contain text inputs and labels that read like questions. Answering them creates job
 * alerts and opens unrelated pages, so they must never be mistaken for the recruiter chat.
 */
function isNaukriPromoWidgetText(text: string): boolean {
  return /job alert|jobs like this|get job alerts|similar jobs|subscribe|newsletter|search jobs here|upgrade to naukri pro|view (?:&|and) update profile|search appearances|recruiter actions|naukri blog|log ?out|sign ?in/i
    .test(text);
}

/** Job-description / listing copy — never treat JD bullets as recruiter questions. */
function isNaukriJobDescriptionText(text: string): boolean {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return false;
  // Numbered / bulleted requirement lines: "1. .NET experience is a must..."
  if (/^\d+[\.\)]\s/.test(t) || /^[-•*]\s/.test(t)) return true;
  if (/job description|roles?\s*(and|&)?\s*responsibilit|key skills|must have|nice to have|preferred skills|about (the )?company|who can apply|education\s*:/i.test(t)) {
    return true;
  }
  // Requirement statements that mention experience but are not questions
  if (!t.includes('?') && /\bis a must\b|\bmust have\b|\brequired\b|\bmandatory\b|\bknowledge of\b/i.test(t)) {
    return true;
  }
  return false;
}

function isInsideGenuineNaukriChatbot(el: Element | null | undefined): boolean {
  if (!el || !(el instanceof Element)) return false;
  return Boolean(
    el.closest?.(
      '.chatbot_NaukriWBot, .botContainer, [class*="NaukriWBot" i], [class*="chatbot_" i], [class*="applyModal" i], [class*="apply-modal" i]',
    ),
  );
}

function containerLooksLikeRecruiterChat(text: string): boolean {
  return /type message|kindly answer|recruiter'?s? questions|skip this question|thank you for your responses|hi [\w\s]+,? thank you for showing interest/i
    .test(text);
}

function isNonRecruiterNaukriWidget(el: Element | null | undefined): boolean {
  if (!el) return false;
  // Anything genuinely inside the recruiter chat is always allowed
  if (isInsideGenuineNaukriChatbot(el)) return false;
  const own = [
    (el as HTMLInputElement).placeholder,
    el.getAttribute?.('aria-label'),
    el.getAttribute?.('name'),
    el.getAttribute?.('id'),
  ].filter(Boolean).join(' ');
  if (isNaukriPromoWidgetText(own)) return true;

  const host = el.closest?.('form, section, aside, [role="dialog"], div');
  const text = ((host as HTMLElement | null)?.innerText || '').replace(/\s+/g, ' ').slice(0, 400);
  return isNaukriPromoWidgetText(text);
}

/**
 * Naukri asks some questions as a bare field label with options below ("Salutation",
 * "Gender"). They carry no "?" so they need to be recognised explicitly.
 */
function isStandaloneChatPrompt(text: string): boolean {
  return /^(salutation|gender|title|marital status|nationality|highest qualification|qualification|education|date of birth|dob|current location|preferred location|preferred cities|notice period|current ctc|expected ctc|total experience|relevant experience|summons\s*\/?\s*notices|languages known|shift|work mode)\s*[:?]?$/i
    .test(text.trim());
}

function looksLikeChatbotQuestion(text: string): boolean {
  const t = text.replace(/\s+/g, ' ').trim();
  const lower = t.toLowerCase();
  if (t.length < 3 || t.length > 500) return false;
  if (isOurChatAnswerLine(t)) return false;
  if (isNaukriPromoWidgetText(t)) return false;
  if (isNaukriJobDescriptionText(t)) return false;
  if (isStandaloneChatPrompt(t)) return true;
  if (t.length < 8) return false;
  if (/type\s*messag|apply\s*now|^save$|search\s*jobs|thank you for showing interest|kindly answer all|recruiter'?s? questions|successfully apply for the job|hi [a-z]+ [a-z]+,? thank you/i.test(lower)) {
    return false;
  }
  // Real recruiter Qs almost always ask something — prefer "?" or interrogative openers.
  // Do NOT match bare JD phrases just because they contain the word "experience".
  return t.includes('?')
    || /^(how|what|where|which|are you|do you|have you|will you|can you|would you|please|enter|rate|tell)/i.test(t)
    || /how many years|years of experi|experi[ea]nce\s*\?|ctc|notice period|current salary|expected salary|lac|lakh|lpa|last working day|residing|relocate|percentage|cgpa|living in|ready to relocate/i.test(lower);
}

/** Pull the current recruiter question from messenger / Yes-No modals even when DOM nesting is odd. */
function extractRecruiterQuestionFromPage(preferredScope?: ParentNode | null): string {
  const scopes: ParentNode[] = [];
  const push = (n: ParentNode | null | undefined) => {
    if (n && !scopes.includes(n)) scopes.push(n);
  };
  push(preferredScope ?? null);
  push(getNaukriQuestionModal());
  const input = findNaukriChatInput(document);
  if (input) push(getChatbotScopeFromInput(input));
  document.querySelectorAll<HTMLElement>(
    '[class*="chatbot" i], [class*="Chatbot"], [class*="NaukriWBot"], [class*="botContainer"], [class*="applyModal" i], [class*="apply-modal" i]',
  ).forEach((el) => {
    if (isVisible(el)) push(el);
  });
  // Only include generic dialogs that already look like recruiter chat — never the whole job page
  document.querySelectorAll<HTMLElement>('[role="dialog"], [class*="modal" i], [class*="Modal"]').forEach((el) => {
    if (!isVisible(el)) return;
    const text = (el.innerText || '').slice(0, 2000);
    if (isNaukriPromoWidgetText(text) || isNaukriJobDescriptionText(text.slice(0, 200))) return;
    if (containerLooksLikeRecruiterChat(text)) push(el);
  });
  // Never push document.body — JD bullets ("1. .NET experience...") look like questions there

  for (const scope of scopes) {
    const scopeText = ((scope as HTMLElement).innerText ?? '').slice(0, 400);
    if (isNaukriPromoWidgetText(scopeText)) continue;

    const fromHelper = getModalQuestionText(scope);
    if (fromHelper && fromHelper.length >= 8 && !isNaukriJobDescriptionText(fromHelper)) {
      return fromHelper;
    }

    const raw = ((scope as HTMLElement).innerText ?? (scope as Document).body?.innerText ?? '')
      .replace(/\u00a0/g, ' ');
    if (!raw) continue;

    // Split on newlines and also on sentence boundaries before How/What/Are
    const chunks = raw
      .split(/\n|(?=(?:How|What|Where|Which|Are you|Do you|Have you|Will you|Can you)\b)/g)
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    for (let i = chunks.length - 1; i >= 0; i--) {
      const chunk = chunks[i];
      if (isNaukriJobDescriptionText(chunk)) continue;
      // Prefer a trailing "?" segment inside a long blob
      const qMatch = chunk.match(/((?:How|What|Where|Which|Are you|Do you|Have you|Will you|Can you|Please)[^?]{6,220}\?)/i);
      if (qMatch && looksLikeChatbotQuestion(qMatch[1])) return qMatch[1].trim();
      if (looksLikeChatbotQuestion(chunk)) return chunk;
    }
  }
  return '';
}

/**
 * Roots that may be scanned for recruiter questions. Everything here must belong to a real
 * chat panel — scanning the job page turned JD lines and the job title into "questions".
 */
function collectChatbotSearchRoots(scope: ParentNode): ParentNode[] {
  const searchIn: ParentNode[] = [];
  const push = (el: ParentNode | null | undefined) => {
    if (!el || searchIn.includes(el)) return;
    if (el === document || el === document.body || el === document.documentElement) return;
    if (el instanceof HTMLElement) {
      if (!isVisible(el)) return;
      const text = (el.innerText || '').slice(0, 2000);
      if (isNaukriPromoWidgetText(text)) return;
      if (!isInsideGenuineNaukriChatbot(el) && !containerLooksLikeRecruiterChat(text)) return;
    }
    searchIn.push(el);
  };

  if (scope instanceof Element) {
    push(scope.closest?.(
      '.chatbot_NaukriWBot, .botContainer, [class*="NaukriWBot" i], [class*="chatbot_" i], [role="dialog"]',
    ));
    push(scope);
  } else {
    push(scope);
  }

  if (searchIn.length === 0) {
    document.querySelectorAll<HTMLElement>(
      '.chatbot_NaukriWBot, .botContainer, [class*="NaukriWBot" i], [class*="chatbot_" i], [class*="botMsg" i]',
    ).forEach((el) => push(el));
  }

  const chat = getOpenNaukriChatContainer();
  if (chat) push(chat);

  return searchIn;
}

function getLastChatbotQuestion(scope: ParentNode): string {
  const searchIn = collectChatbotSearchRoots(scope);

  for (const root of searchIn) {
    const host = root as HTMLElement;
    const lines = (host.innerText ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => Boolean(l) && !/^save$|^send$|^submit$|type\s*messag/i.test(l));

    const questionIndexes: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (looksLikeChatbotQuestion(lines[i])) questionIndexes.push(i);
    }
    if (questionIndexes.length === 0) continue;

    // Prefer last question with no answer beneath it (current prompt)
    for (let q = questionIndexes.length - 1; q >= 0; q--) {
      const start = questionIndexes[q];
      const end = q + 1 < questionIndexes.length ? questionIndexes[q + 1] : lines.length;
      const answers = lines.slice(start + 1, end);
      if (answers.length === 0) return lines[start];
    }

    // All prior questions answered — still return the last one (open input)
    return lines[questionIndexes[questionIndexes.length - 1]];
  }

  // Bubble fallback
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const root of searchIn) {
    const bubbles = root.querySelectorAll<HTMLElement>(
      '[class*="botMsg"], [class*="bot-msg"], [class*="BotMsg"], [class*="question"], [class*="message"], [class*="bubble"], [class*="chatMsg"], li, p',
    );
    for (const el of bubbles) {
      if ((el.textContent?.length ?? 0) > 500) continue;
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!looksLikeChatbotQuestion(text) || seen.has(text)) continue;
      seen.add(text);
      candidates.push(text);
    }
  }
  return candidates.length > 0 ? candidates[candidates.length - 1] : '';
}

function getRadioLabel(radio: HTMLInputElement): string {
  if (radio.getAttribute('aria-label')) {
    return (radio.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  }
  const forLab = radio.id
    ? document.querySelector<HTMLElement>(`label[for="${radio.id}"]`)
    : null;
  const wrap = forLab ?? (radio.closest('label') as HTMLElement | null);
  if (wrap) {
    const clone = wrap.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('input, svg, button, img').forEach((n) => n.remove());
    const t = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    if (t && t.length <= 60) return t;
  }
  const next = radio.nextElementSibling?.textContent?.replace(/\s+/g, ' ').trim();
  if (next && next.length <= 60) return next;
  return (radio.value || '').trim();
}

function isWalkInAttendQuestion(question: string): boolean {
  return /walk-?\s*in|will you attend|attend the (interview|walk)/i.test(question);
}

function isResidingYesNoQuestion(question: string): boolean {
  const q = question.toLowerCase();
  if (/where are you|which city|what (is|is your) (your )?location|current location\?/i.test(q)) return false;
  return /are you (currently )?(resid|living)|currently resid|residing in|living in\s+[a-z]|based in\s+[a-z].*\?/i.test(q)
    || /residing in .+ or willing to relocate|willing to relocate to|ready to relocate|living in or ready/i.test(q);
}

/** Compare profile.currentLocation to a city named in a Yes/No residing question. */
function residingYesNoAnswer(question: string, profile: Profile): 'Yes' | 'No' {
  const loc = normalizeText(profile.currentLocation || '');
  const q = normalizeText(question);
  const cities = [
    'bengaluru', 'bangalore', 'hyderabad', 'pune', 'mumbai', 'delhi', 'new delhi',
    'noida', 'gurgaon', 'gurugram', 'chennai', 'kolkata', 'ahmedabad', 'jaipur',
    'chandigarh', 'kochi', 'trivandrum', 'indore', 'nagpur', 'coimbatore',
  ];
  const asked = cities.filter((c) => q.includes(c));
  // "living in OR ready/willing to relocate" — Yes if living there OR open to relocate
  if (/willing to relocate|ready to relocate|or willing|or ready to/i.test(question)
    && profile.willingToRelocate !== false) {
    return 'Yes';
  }
  if (asked.length === 0) {
    return profile.willingToRelocate === false ? 'No' : 'Yes';
  }
  const locFlat = loc.replace(/bangalore/g, 'bengaluru').replace(/gurugram/g, 'gurgaon');
  const matches = asked.some((c) => {
    const city = c === 'bangalore' ? 'bengaluru' : c === 'gurugram' ? 'gurgaon' : c;
    return locFlat.includes(city) || loc.includes(c);
  });
  return matches ? 'Yes' : 'No';
}

function preferredYesNoForQuestion(questionText: string, profile: Profile): 'yes' | 'no' {
  const q = questionText.toLowerCase();
  if (isWalkInAttendQuestion(questionText)) return 'yes';
  if (isResidingYesNoQuestion(questionText) || /relocate|residing|living in|willing to move|ready to relocate|located in/i.test(q)) {
    return residingYesNoAnswer(questionText, profile).toLowerCase() as 'yes' | 'no';
  }
  if (/sponsor|visa/.test(q)) return profile.requiresSponsorship ? 'yes' : 'no';
  if (/authoriz|work permit|eligible/.test(q)) return profile.workAuthorization === 'No' ? 'no' : 'yes';
  return 'yes';
}

type ChoiceOption = { el: HTMLElement; label: string; input?: HTMLInputElement };

/** Broad chatbot panel — must include question + Yes/No options, not just the footer input. */
function findNaukriChatbotContainer(): HTMLElement | null {
  const selectors = [
    '.chatbot_NaukriWBot',
    '.botContainer',
    '[class*="NaukriWBot"]',
    '[class*="chatbot_"]',
    '[class*="Chatbot"]',
    '[class*="chatbot"]',
    '[class*="applyModal"]',
    '[class*="apply-modal"]',
    '[role="dialog"]',
  ];
  let best: HTMLElement | null = null;
  let bestScore = 0;
  for (const sel of selectors) {
    document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      if (!isVisible(el)) return;
      if (el.querySelector('#apply-button, button#apply-button')) return;
      const text = (el.innerText || '').slice(0, 2000).toLowerCase();
      // Profile menu / job-alert popups are dialogs too — never treat them as the chat
      if (isNaukriPromoWidgetText(text)) return;
      // Job detail panels can match [role="dialog"] — reject JD-only nodes
      if (/job description|roles?\s*(and|&)?\s*responsibilit|key skills|send me jobs like this/i.test(text)
        && !containerLooksLikeRecruiterChat(text)) {
        return;
      }
      let score = 0;
      const isKnownChatClass = /naukriwbot|chatbot_|botcontainer|applymodal|apply-modal/i
        .test(el.className?.toString() || '');
      if (isKnownChatClass) score += 80;
      if (containerLooksLikeRecruiterChat(text)) score += 50;
      if (/will you attend|walk-?\s*in|relocat|resid|how many years|whitefield|mg road/i.test(text)) score += 30;
      if (el.querySelector('input[type="radio"], [role="radio"], input[type="checkbox"]')) score += 20;
      if (el.querySelector('input, textarea, [contenteditable]')) score += 10;
      if (/\bsave\b/i.test(el.innerText || '') && containerLooksLikeRecruiterChat(text)) score += 15;
      const rect = el.getBoundingClientRect();
      if (rect.height > 200 && rect.width > 200 && isKnownChatClass) score += 10;
      // Require strong evidence — size+input alone must not win
      if (score < 50) return;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    });
  }
  if (best) return best;

  const chatInput = findNaukriChatInput(document);
  if (chatInput && !isNonRecruiterNaukriWidget(chatInput)) {
    const scope = getChatbotScopeFromInput(chatInput);
    if (scope instanceof HTMLElement) {
      const text = (scope.innerText || '').slice(0, 2000);
      if (containerLooksLikeRecruiterChat(text) || isInsideGenuineNaukriChatbot(chatInput)) {
        return scope;
      }
    }
  }
  return null;
}

function collectNaukriChoiceOptions(scope: ParentNode): ChoiceOption[] {
  const options: ChoiceOption[] = [];
  const seen = new Set<HTMLElement>();

  const add = (el: HTMLElement, label: string, input?: HTMLInputElement) => {
    let cleaned = label.replace(/\s+/g, ' ').trim();
    // Parent text pollution used to exceed 80 chars and drop Whitefield / MG Road / Skip
    if (cleaned.length > 60) {
      const cut = cleaned.split(/\s{2,}|\n/)[0]?.trim() || cleaned.slice(0, 40);
      cleaned = cut.length <= 60 ? cut : cleaned.slice(0, 40);
    }
    if (!cleaned) {
      cleaned = (input?.value || input?.getAttribute('aria-label') || '').trim();
    }
    if (!cleaned || cleaned.length > 80) return;
    if (/^save$|^submit$|^send$|^type message|^hi /i.test(cleaned)) return;
    if (seen.has(el)) return;
    seen.add(el);
    options.push({ el, label: cleaned, input });
  };

  // Native radios (often opacity:0 — still collect; click the label)
  scope.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach((radio) => {
    const label = getRadioLabel(radio);
    const clickTarget = (radio.id
      ? document.querySelector<HTMLElement>(`label[for="${radio.id}"]`)
      : null)
      ?? (radio.closest('label') as HTMLElement | null)
      ?? (radio.parentElement as HTMLElement | null)
      ?? radio;
    add(clickTarget, label || radio.value || 'radio', radio);
  });

  scope.querySelectorAll<HTMLElement>('[role="radio"]').forEach((el) => {
    add(el, el.getAttribute('aria-label') || el.textContent || '');
  });

  // Custom chips / list items that look like Yes/No or experience ranges
  const optionLike = scope.querySelectorAll<HTMLElement>(
    'label, li, [class*="option" i], [class*="radio" i], [class*="choice" i], [class*="chip" i], [class*="answer" i], button, div[tabindex], span[tabindex]',
  );
  const scopeIsChat = scope instanceof Element
    ? (isInsideGenuineNaukriChatbot(scope) || containerLooksLikeRecruiterChat((scope as HTMLElement).innerText || ''))
    : false;
  /** A real choice must be clickable/checkable — a chat transcript bubble is not. */
  const isSelectableControl = (el: HTMLElement): boolean => {
    if (el.querySelector('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]')) {
      return true;
    }
    const role = el.getAttribute('role');
    if (role === 'radio' || role === 'checkbox' || role === 'option') return true;
    if (el.tagName === 'LABEL' && el.querySelector('input')) return true;
    const cls = (el.className?.toString() || '').toLowerCase();
    return /option|choice|chip|radio|checkbox|selectable/.test(cls);
  };

  /** Answers we already sent are echoed back as chat bubbles — never re-select them. */
  const isOwnAnswerBubble = (el: HTMLElement): boolean => Boolean(
    el.closest(
      '[class*="userMssg" i], [class*="userMsg" i], [class*="user-msg" i], [class*="usrMssg" i], [class*="sentMsg" i], [class*="rightMsg" i]',
    ),
  );

  for (const el of optionLike) {
    if (el.closest('input, textarea, [contenteditable]')) continue;
    // Never treat job-description list items as chat options
    if (el.closest('[class*="job-desc" i], [class*="jobDesc" i], [class*="styles_jhc" i], #job_description, .dang-inner-html')) {
      continue;
    }
    if (isOwnAnswerBubble(el)) continue;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 60) continue;
    if (isNaukriJobDescriptionText(text)) continue;
    const isBareNumber = /^(>=?\s*|≤\s*|<=\s*)?\d+(\.\d+)?\+?$/.test(text);
    // Bare numbers (1, 2, 3…) are only valid inside a real chat — otherwise JD "1." / filters match
    if (isBareNumber && !scopeIsChat && !isInsideGenuineNaukriChatbot(el)) continue;
    // A bare number that is not a checkbox/radio is our own answer echoed in the transcript
    if (isBareNumber && !isSelectableControl(el)) continue;
    const looksLikeOption =
      /^(yes|no)\b/i.test(text)
      || /yes,? i will|no,? i will|will attend|will not/i.test(text)
      || /no experience|fresher|<\s*1\s*year|1\s*[-–]\s*2\s*year|2\s*[-–]\s*3\s*year|>\s*3\s*year|more than 3/i.test(text)
      || isBareNumber
      || /skip this question|whitefield|mg road|koramangala|hsr|indiranagar/i.test(text);
    if (!looksLikeOption) continue;
    if (el.querySelectorAll('input[type="radio"], [role="radio"], input[type="checkbox"]').length > 1) continue;
    if ((el.innerText || '').split('\n').filter(Boolean).length > 3) continue;
    add(el, text);
  }

  // Checkboxes as choices — ALWAYS include (label fix above); do not require keyword match
  scope.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((cb) => {
    const label = getCheckboxLabel(cb);
    const clickTarget = (cb.id
      ? document.querySelector<HTMLElement>(`label[for="${cb.id}"]`)
      : null)
      ?? (cb.closest('label') as HTMLElement | null)
      ?? cb;
    add(clickTarget, label || cb.value || 'checkbox', cb);
  });

  return options;
}

function scoreExperienceRangeLabel(label: string, years: number): number {
  const l = label.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/no experience|fresher|^nil$|zero/.test(l)) return years <= 0 ? 100 : -1;
  if (/<\s*1|less than\s*1|below\s*1|0\s*[-–]\s*1/.test(l)) return years > 0 && years < 1 ? 100 : -1;
  if (/>\s*3|more than\s*3|above\s*3|over\s*3/.test(l) && !/^>=?\s*\d/.test(l)) {
    return years > 3 ? 100 : years >= 3 ? 70 : -1;
  }
  // ">=5", "≥5", "5+", ">5"
  const gte = l.match(/^(?:>=|≥|>)\s*(\d+(?:\.\d+)?)$/) || l.match(/^(\d+(?:\.\d+)?)\+$/);
  if (gte) {
    const n = Number(gte[1]);
    if (!Number.isFinite(n)) return -1;
    return years >= n ? 95 : Math.max(0, 40 - Math.abs(years - n) * 10);
  }
  // "<=2", "<3"
  const lte = l.match(/^(?:<=|≤|<)\s*(\d+(?:\.\d+)?)$/);
  if (lte) {
    const n = Number(lte[1]);
    if (!Number.isFinite(n)) return -1;
    return years <= n ? 95 : -1;
  }
  const range = l.match(/(\d+(?:\.\d+)?)\s*[-–to]+\s*(\d+(?:\.\d+)?)/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (years >= a && years <= b) return 90 - Math.abs(((a + b) / 2) - years);
    return -1;
  }
  const single = l.match(/^(\d+)\s*\+?\s*years?$/);
  if (single) {
    const n = Number(single[1]);
    return Math.abs(n - years) < 0.6 ? 80 : -1;
  }
  // Bare checkbox labels: "2", "3", "4", "5" (Hyperworks-style)
  const bare = l.match(/^(\d+(?:\.\d+)?)$/);
  if (bare) {
    const n = Number(bare[1]);
    if (!Number.isFinite(n)) return -1;
    const diff = Math.abs(n - years);
    if (diff < 0.6) return 92;
    if (diff <= 1) return 70;
    if (diff <= 2) return 40;
    return -1;
  }
  return -1;
}

function hasRealSelectableChoices(
  options: ChoiceOption[],
  questionText: string,
  chatInput: HTMLElement | null,
): boolean {
  if (options.length === 0) return false;
  const meaningful = options.filter((o) => !/^skip(\s+this\s+question)?$/i.test(o.label.trim()));
  const hasYearRanges = meaningful.some(
    (o) => scoreExperienceRangeLabel(o.label, 5) >= 0
      || /no experience|fresher|<\s*1\s*year|1\s*[-–]\s*2|2\s*[-–]\s*3|>\s*3|^(>=?\s*)?\d+\+?$/i.test(o.label),
  );
  const hasYesNo = meaningful.some(
    (o) => /^(yes|no)\b/i.test(o.label.trim()) || /will attend|will not attend/i.test(o.label),
  );
  const hasLocationAreas = options.some(
    (o) => /whitefield|mg road|koramangala|hsr|indiranagar|electronic city|skip this question/i.test(o.label),
  );
  const hasNativeChoice = meaningful.some(
    (o) => o.input?.type === 'radio' || o.input?.type === 'checkbox'
      || o.el.getAttribute('role') === 'radio'
      || o.el.getAttribute('role') === 'checkbox',
  );
  const hasBareYearNumbers = meaningful.some(
    (o) => /^(>=?\s*|≤\s*|<=\s*)?\d+(\.\d+)?\+?$/.test(o.label.trim()),
  );

  // Free-text chat only when there are truly no selectable options (Skip alone does not count)
  if (
    chatInput
    && /how many years|years of experience|experience (do you have|in)\b/i.test(questionText)
    && !hasYearRanges
    && !hasBareYearNumbers
    && !hasNativeChoice
  ) {
    return false;
  }

  return hasYearRanges || hasYesNo || hasLocationAreas || hasNativeChoice || hasBareYearNumbers;
}

function pickChoiceOption(
  questionText: string,
  profile: Profile,
  options: ChoiceOption[],
): ChoiceOption | null {
  if (options.length === 0) return null;
  const q = questionText.toLowerCase();
  const years = profile.totalExperienceYears > 0 ? profile.totalExperienceYears : 2;

  // Never return Skip for experience questions when year-range radios exist or when typing is preferred
  const nonSkip = options.filter((o) => !/^skip(\s+this\s+question)?$/i.test(o.label.trim()));

  // Experience range radios / bare year checkboxes (2, 3, 4, 5, >=5)
  if (/how many years|years of experience|experience (do you have|in)|exp in|fullstack|full\s*stack/i.test(q)
    || options.some((o) => scoreExperienceRangeLabel(o.label, years) >= 0)
    || options.some((o) => /^(>=?\s*|≤\s*|<=\s*)?\d+(\.\d+)?\+?$/.test(o.label.trim()))) {
    let best: ChoiceOption | null = null;
    let bestScore = -1;
    for (const o of nonSkip) {
      const s = scoreExperienceRangeLabel(o.label, years);
      if (s > bestScore) {
        bestScore = s;
        best = o;
      }
    }
    if (best && bestScore >= 0) return best;
    // Closest bare-number fallback (never leave experience checkboxes unclicked)
    let closest: ChoiceOption | null = null;
    let closestDiff = Number.POSITIVE_INFINITY;
    for (const o of nonSkip) {
      const m = o.label.trim().match(/(\d+(?:\.\d+)?)/);
      if (!m) continue;
      const diff = Math.abs(Number(m[1]) - years);
      if (diff < closestDiff) {
        closestDiff = diff;
        closest = o;
      }
    }
    if (closest) return closest;
    return null;
  }

  // Location / area checkboxes
  if (/resid|relocat|location|area|office|bengaluru|bangalore/i.test(q)
    || options.some((o) => /whitefield|mg road|skip this|koramangala/i.test(o.label))) {
    const wantYes = preferredYesNoForQuestion(questionText, profile) === 'yes';
    const skip = options.find((o) => /skip/i.test(o.label));
    const areas = options.filter((o) => !/skip|yes\b|no\b/i.test(o.label));
    if (!wantYes && skip) return skip;
    if (areas.length > 0) {
      const loc = normalizeText(profile.currentLocation || '');
      const matched = areas.find((a) => loc && a.label.toLowerCase().includes(loc.split(',')[0]));
      return matched ?? areas[0];
    }
    if (skip) return skip;
  }

  // Yes / No
  const prefer = preferredYesNoForQuestion(questionText, profile);
  for (const o of nonSkip) {
    const l = o.label.toLowerCase().trim();
    if (prefer === 'yes' && /^(yes\b|yes,)/.test(l) && !/\bno\b/.test(l.slice(0, 8))) return o;
    if (prefer === 'no' && /^(no\b|no,)/.test(l)) return o;
  }
  for (const o of nonSkip) {
    const l = o.label.toLowerCase();
    if (prefer === 'yes' && l.includes('yes') && !l.includes('not')) return o;
    if (prefer === 'no' && (l.startsWith('no') || l.includes('will not'))) return o;
  }

  return nonSkip[0] ?? null;
}

function clickNaukriChoiceOption(option: ChoiceOption): void {
  // Prefer a single click target — clicking label + input toggles checkboxes OFF (click/unclick).
  const labelFor = option.input?.id
    ? document.querySelector<HTMLElement>(`label[for="${option.input.id}"]`)
    : null;
  const target: HTMLElement = labelFor
    ?? (option.input?.closest('label') as HTMLElement | null)
    ?? option.el;

  try {
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
  } catch {
    // ignore
  }

  if (option.input) {
    // Force checked ON without a prior toggle click
    if (!option.input.checked) {
      option.input.click();
    }
    if (!option.input.checked) {
      option.input.checked = true;
      option.input.dispatchEvent(new Event('input', { bubbles: true }));
      option.input.dispatchEvent(new Event('change', { bubbles: true }));
      forceClick(target);
    }
    if (option.input.getAttribute('role') === 'checkbox' || option.input.type === 'checkbox') {
      option.input.setAttribute('aria-checked', 'true');
    }
  } else {
    if (target.getAttribute('role') === 'radio' || target.getAttribute('role') === 'checkbox') {
      target.setAttribute('aria-checked', 'true');
    }
    forceClick(target);
  }
}

/**
 * Prefer clicking radios/checkboxes/option chips over typing into chat.
 * Uses local click + MAIN-world/CDP trusted click (Naukri ignores isolated-world clicks).
 */
async function selectNaukriQuestionOptions(
  scope: ParentNode,
  questionText: string,
  profile: Profile,
  _jobTitle?: string,
): Promise<boolean> {
  const container = (scope instanceof HTMLElement ? scope : null)
    ?? findNaukriChatbotContainer()
    ?? document.body;
  let options = collectNaukriChoiceOptions(container);
  if (options.length === 0) {
    const save = findNaukriSaveButton(document);
    const near = save?.closest('[role="dialog"], [class*="chat"], [class*="bot"], [class*="modal"], form')
      ?? document.body;
    options = collectNaukriChoiceOptions(near);
  }
  // Absolute fallback: every checkbox/radio on the page near a Save button
  if (options.length === 0) {
    options = collectNaukriChoiceOptions(document.body).filter((o) => {
      const r = o.el.getBoundingClientRect();
      return r.top > 0 && r.top < window.innerHeight;
    });
  }
  if (options.length === 0) return false;

  const pick = pickChoiceOption(questionText, profile, options);
  if (!pick) return false;

  emit({
    status: 'searching',
    reason: `Selecting option: "${pick.label}"`,
  });
  clickNaukriChoiceOption(pick);
  await sleep(350);

  // Verify checkbox/radio stayed checked (Naukri double-click toggles off)
  if (pick.input && !pick.input.checked) {
    emit({ status: 'searching', reason: `Re-checking option "${pick.label}" (was toggled off)...` });
    pick.input.checked = true;
    pick.input.dispatchEvent(new Event('input', { bubbles: true }));
    pick.input.dispatchEvent(new Event('change', { bubbles: true }));
    const labelFor = pick.input.id
      ? document.querySelector<HTMLElement>(`label[for="${pick.input.id}"]`)
      : null;
    forceClick(labelFor ?? pick.el);
    await sleep(200);
  }

  // Trusted MAIN-world click ONLY if still unchecked — avoid second toggle
  const needsTrusted = !pick.input || !pick.input.checked;
  if (needsTrusted) {
    try {
      const res = await sendRuntimeMessage<{
        ok?: boolean;
        clicked?: boolean;
        label?: string;
        checked?: boolean;
      }>({
        type: 'CLICK_NAUKRI_OPTION',
        payload: { preferredLabel: pick.label, questionHint: questionText, ensureChecked: true },
      }, 8000);
      if (res?.clicked) {
        emit({
          status: 'searching',
          reason: `Option clicked (trusted): "${res.label || pick.label}"`,
        });
      }
    } catch {
      // local click already attempted
    }
  } else {
    emit({
      status: 'searching',
      reason: `Option selected: "${pick.label}" (checked)`,
    });
  }

  // Final verify
  if (pick.input) {
    pick.input.checked = true;
    pick.input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return Boolean(!pick.input || pick.input.checked);
}

function questionHasChoiceControls(scope: ParentNode): boolean {
  const container = findNaukriChatbotContainer() ?? scope;
  const chatInput = findNaukriChatInput(document);
  const q = extractRecruiterQuestionFromPage(container) || '';
  return hasRealSelectableChoices(collectNaukriChoiceOptions(container), q, chatInput);
}

/** @deprecated kept for call sites — delegates to pickChoiceOption path */
function pickRadioForQuestion(questionText: string, profile: Profile, radios: NodeListOf<Element> | HTMLInputElement[]): HTMLInputElement {
  const list = Array.from(radios) as HTMLInputElement[];
  const options: ChoiceOption[] = list.map((r) => ({
    el: (r.closest('label') as HTMLElement | null) ?? r,
    label: getRadioLabel(r),
    input: r,
  }));
  const pick = pickChoiceOption(questionText, profile, options);
  return (pick?.input ?? list[0]) as HTMLInputElement;
}

/** Location / area checkboxes (Whitefield, MG Road, Skip this question). */
async function fillNaukriLocationChoiceCheckboxes(
  scope: ParentNode,
  questionText: string,
  profile: Profile,
): Promise<boolean> {
  return selectNaukriQuestionOptions(scope, questionText, profile);
}

function experienceAnswer(profile: Profile): string {
  return String(profile.totalExperienceYears > 0 ? profile.totalExperienceYears : 2);
}

/** Profile CTC may be stored as Lacs (10) or absolute rupees (1000000). Questions often ask for Lacs. */
function ctcInLacs(value: number | undefined): string | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  if (value >= 100000) return String(Math.round((value / 100000) * 10) / 10);
  return String(value);
}

function ctcAbsoluteRupees(value: number | undefined): string | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  if (value < 1000) return String(Math.round(value * 100000));
  return String(Math.round(value));
}

function noticePeriodAnswer(profile: Profile, question = ''): string {
  const notice = profile.noticePeriod ?? 'Immediate';
  const q = question.toLowerCase();
  if (q.includes('last working day') || q.includes('serving')) {
    if (notice === 'Immediate') return 'Immediate joiner — not serving notice';
    return `${notice} (currently serving notice)`;
  }
  return notice;
}

/** Normalize city aliases so "Bangalore, India" matches "Bengaluru". */
function cityAliases(raw: string): string[] {
  const base = normalizeText(raw)
    .replace(/,?\s*(india|bharat|in)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return [];
  const aliases = new Set<string>([base]);
  // First token often is the city ("Bangalore, Karnataka")
  const first = base.split(/[|,/–-]/)[0]?.trim();
  if (first && first.length >= 3) aliases.add(first);

  const map: Array<[RegExp, string[]]> = [
    [/bengaluru|bangalore|blr\b/, ['bengaluru', 'bangalore', 'bengalooru']],
    [/mumbai|bombay/, ['mumbai', 'bombay']],
    [/delhi|new delhi|ncr/, ['delhi', 'new delhi', 'ncr', 'gurgaon', 'gurugram', 'noida']],
    [/gurugram|gurgaon/, ['gurugram', 'gurgaon']],
    [/hyderabad/, ['hyderabad']],
    [/chennai|madras/, ['chennai', 'madras']],
    [/pune/, ['pune']],
    [/kolkata|calcutta/, ['kolkata', 'calcutta']],
    [/ahmedabad/, ['ahmedabad']],
    [/jaipur/, ['jaipur']],
    [/kochi|cochin/, ['kochi', 'cochin']],
    [/chandigarh/, ['chandigarh']],
    [/indore/, ['indore']],
    [/remote|work from home|wfh/, ['remote', 'work from home', 'anywhere']],
  ];
  for (const [re, list] of map) {
    if (re.test(base) || (first && re.test(first))) {
      for (const a of list) aliases.add(a);
    }
  }
  return [...aliases];
}

function scoreLinkedInOptionMatch(optionText: string, needles: string[]): number {
  const opt = normalizeText(optionText);
  if (!opt || opt.startsWith('select')) return -1;
  let best = -1;
  for (const needle of needles) {
    if (!needle) continue;
    if (opt === needle) best = Math.max(best, 100);
    else if (opt.startsWith(needle) || needle.startsWith(opt)) best = Math.max(best, 80);
    else if (opt.includes(needle) || needle.includes(opt)) best = Math.max(best, 60);
  }
  return best;
}

/** Map profile notice period → LinkedIn Easy Apply radio/dropdown labels. */
function linkedInNoticePeriodOptionNeedles(profile: Profile): string[] {
  const notice = profile.noticePeriod ?? 'Immediate';
  switch (notice) {
    case 'Immediate':
      return ['available now', 'immediate', 'immediately', 'joining immediately', 'can join immediately', '0 days', 'serving notice: no'];
    case '15 days':
      return ['two weeks', 'one week', '15 days', '15 day', '2 weeks', '1 week', 'currently serving'];
    case '30 days':
      return ['one month', '1 month', '30 days', '30 day', '4 weeks', 'currently serving'];
    case '60 days':
      return ['two months', '2 months', '60 days', '60 day', 'currently serving'];
    case '90+ days':
      return ['three months', '3 months', '90 days', '90 day', '90+', 'currently serving'];
    default:
      return ['available now', 'one month', 'currently serving'];
  }
}

function pickLinkedInNoticePeriodOption<T>(
  items: T[],
  getText: (item: T) => string,
  profile: Profile,
): T | undefined {
  const needles = linkedInNoticePeriodOptionNeedles(profile);
  let best: { item: T; score: number } | undefined;
  for (const item of items) {
    const score = scoreLinkedInOptionMatch(getText(item), needles);
    if (score < 0) continue;
    // Prefer exact-ish matches over fallback "currently serving"
    if (!best || score > best.score) best = { item, score };
  }
  if (best && best.score >= 60) return best.item;

  // Soft fallbacks by priority for common LinkedIn lists
  const fallbackOrder = profile.noticePeriod === 'Immediate'
    ? ['available now', 'one week', 'two weeks', 'one month']
    : ['one month', 'two weeks', 'two months', 'three months', 'currently serving', 'available now'];
  for (const fb of fallbackOrder) {
    const hit = items.find((item) => {
      const t = normalizeText(getText(item));
      return t === fb || t.includes(fb);
    });
    if (hit) return hit;
  }
  return undefined;
}

function pickLinkedInCityOption<T>(
  items: T[],
  getText: (item: T) => string,
  profile: Profile,
): T | undefined {
  const needles = cityAliases(profile.currentLocation || '');
  let best: { item: T; score: number } | undefined;
  for (const item of items) {
    const score = scoreLinkedInOptionMatch(getText(item), needles);
    if (score < 0) continue;
    if (!best || score > best.score) best = { item, score };
  }
  if (best && best.score >= 60) return best.item;

  // Prefer Remote / Anywhere / India if present when city not listed
  for (const fb of ['remote', 'anywhere', 'work from home', 'india', 'any location', 'any']) {
    const hit = items.find((item) => {
      const t = normalizeText(getText(item));
      return t === fb || t.includes(fb);
    });
    if (hit) return hit;
  }
  // Last resort: first real option (better than leaving blank on required field)
  return items.find((item) => {
    const t = normalizeText(getText(item));
    return t && !t.startsWith('select') && t !== 'other';
  });
}

function isLinkedInCityQuestion(label: string): boolean {
  const q = label.toLowerCase();
  return /preferred cit|cities to work|choose .*cit|preferred location|work location|location preference|which city|select .*cit/i.test(q);
}

function isLinkedInNoticeAvailabilityQuestion(label: string): boolean {
  const q = label.toLowerCase();
  return /notice period|availability to start|available to (start|join)|when can you (start|join)|joining (date|time)|how soon can you/i.test(q);
}

function formatPercentage(value: number | undefined): string | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/** Profile stores DOB as YYYY-MM-DD; chats ask for it in several layouts. */
function formatDateOfBirth(dob: string | undefined, question = ''): string | undefined {
  const parts = (dob ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) return undefined;
  const [, yyyy, mm, dd] = parts;
  const q = question.toLowerCase();
  if (/yyyy\s*[-/]\s*mm\s*[-/]\s*dd/.test(q)) return `${yyyy}-${mm}-${dd}`;
  if (/mm\s*[-/]\s*dd\s*[-/]\s*yyyy/.test(q)) return `${mm}/${dd}/${yyyy}`;
  if (/dd\s*-\s*mm\s*-\s*yyyy/.test(q)) return `${dd}-${mm}-${yyyy}`;
  return `${dd}/${mm}/${yyyy}`;
}

function ageFromDateOfBirth(dob: string | undefined): number | undefined {
  const parts = (dob ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) return undefined;
  const birth = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  if (Number.isNaN(birth.getTime())) return undefined;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const beforeBirthday = now.getMonth() < birth.getMonth()
    || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 120 ? age : undefined;
}

/** Native date pickers only accept YYYY-MM-DD — convert the display format back. */
function coerceAnswerForInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): string {
  const type = (input as HTMLInputElement).type?.toLowerCase();
  if (type !== 'date') return value;
  const dmy = value.trim().match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return value;
}

/** Pick 10th / 12th / graduation / CGPA from profile based on the question text. */
function academicAnswer(question: string, profile: Profile): string | undefined {
  const q = question.toLowerCase();

  if (/cgpa|sgpa|gpa|out of\s*10|\/\s*10/.test(q)) {
    return formatPercentage(profile.cgpa) ?? formatPercentage(profile.graduationPercentage);
  }
  if (/out of\s*5|\/\s*5/.test(q) && profile.cgpa != null) {
    return formatPercentage(Math.round((profile.cgpa / 10) * 5 * 10) / 10);
  }

  if (/10th|tenth|class\s*10|ssc|matriculation/.test(q)) {
    return formatPercentage(profile.percentage10th)
      ?? formatPercentage(profile.percentage12th)
      ?? formatPercentage(profile.graduationPercentage);
  }
  if (/12th|twelfth|class\s*12|hsc|intermediate|senior secondary|diploma/.test(q)) {
    return formatPercentage(profile.percentage12th)
      ?? formatPercentage(profile.graduationPercentage)
      ?? formatPercentage(profile.percentage10th);
  }
  if (/graduat|b\.?tech|b\.?e\.?\b|degree|college|university|bachelors|bachelor/.test(q)) {
    return formatPercentage(profile.graduationPercentage)
      ?? formatPercentage(profile.percentage12th)
      ?? formatPercentage(profile.percentage10th);
  }

  // Generic "percentage" / "marks" / "aggregate"
  return formatPercentage(profile.graduationPercentage)
    ?? formatPercentage(profile.percentage12th)
    ?? formatPercentage(profile.percentage10th)
    ?? formatPercentage(profile.cgpa);
}

function skillsAnswer(profile: Profile): string {
  const cover = profile.coverLetterTemplate?.trim();
  if (cover) {
    // Use a short cover snippet only when it looks like a skill list
    const firstLine = cover.split('\n')[0]?.trim() ?? '';
    if (firstLine.length >= 8 && firstLine.length <= 180 && /[,|/]/.test(firstLine)) {
      return firstLine;
    }
  }
  return 'JavaScript, TypeScript, React, Node.js, HTML, CSS';
}

function proficiencyRating(profile: Profile): string {
  const years = profile.totalExperienceYears > 0 ? profile.totalExperienceYears : 2;
  // Map years of experience to a 1–10 self-rating (capped)
  return String(Math.min(9, Math.max(6, Math.round(5 + years / 2))));
}

function mapChatbotAnswer(question: string, profile: Profile): string | undefined {
  let raw = (question ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return undefined;
  // If a polluted mega-label slipped through, keep only the first question
  if (raw.length > 220) {
    const firstQ = raw.match(/^(.{8,220}\?)/);
    raw = firstQ ? firstQ[1] : raw.slice(0, 220);
  }
  const q = raw.toLowerCase();

  if (q.includes('full name') || q.includes('your name') || q === 'name' || /\bfirst name\b|\blast name\b/.test(q)) {
    return profile.fullName;
  }

  // Bare field prompts with options below ("Salutation", "Gender")
  if (/^salutation\s*[:?]?$/.test(q) || /\bsalutation\b|\btitle \(mr|prefix\b/.test(q)) return 'Mr';
  if (/^gender\s*[:?]?$/.test(q)) return 'Male';

  if (/date of birth|\bdob\b|birth date|birthdate|when were you born/.test(q)) {
    return formatDateOfBirth(profile.dateOfBirth, raw);
  }
  if (/\bage\b/.test(q) && !/average|package/.test(q)) {
    const age = ageFromDateOfBirth(profile.dateOfBirth);
    if (age != null) return String(age);
  }

  // Walk-in / attend — before CTC/notice so we never type salary into this question
  if (isWalkInAttendQuestion(raw)) {
    return 'Yes';
  }

  const asksLacs = /lac|lakh|lpa|per annum|p\.a/.test(q);
  const asksExpectedCtc = /expected ctc|expected salary|desired salary|salary expectation|expected compensation|how much salary|ctc.*expect|expect.*ctc/.test(q);
  const asksCurrentCtc = /current ctc|current salary|present ctc|present salary|last drawn|current compensation/.test(q);

  // Must run before generic "experience" / default fallbacks
  if (asksExpectedCtc || (asksLacs && /expect|desired|ctc|salary/.test(q) && !asksCurrentCtc)) {
    if (asksLacs || /lac|lakh/.test(q)) {
      return ctcInLacs(profile.expectedCTC) ?? ctcInLacs(profile.currentCTC);
    }
    return ctcAbsoluteRupees(profile.expectedCTC) ?? ctcInLacs(profile.expectedCTC);
  }
  if (asksCurrentCtc) {
    if (asksLacs || /lac|lakh/.test(q)) {
      return ctcInLacs(profile.currentCTC) ?? ctcInLacs(profile.expectedCTC);
    }
    return ctcAbsoluteRupees(profile.currentCTC) ?? ctcInLacs(profile.currentCTC);
  }

  if (
    q.includes('notice')
    || q.includes('last working day')
    || q.includes('serving notice')
    || q.includes('joining')
    || q.includes('join immediately')
    || q.includes('available to join')
    || q.includes('availability to start')
    || q.includes('when can you join')
    || q.includes('when can you start')
  ) {
    return noticePeriodAnswer(profile, q);
  }

  // Academic / score questions — use profile percentages (never experience years)
  if (
    /percent|percentage|%|marks|scored|score in|aggregate|cgpa|sgpa|gpa|grade|10th|12th|ssc|hsc|graduation|diploma|board exam/i.test(q)
  ) {
    return academicAnswer(q, profile);
  }

  if (q.includes('phone') || q.includes('mobile') || q.includes('contact number') || q.includes('whatsapp')) {
    return profile.phone;
  }
  if (q.includes('email') || q.includes('mail id')) return profile.email;

  // Yes/No: "Are you currently residing in Bengaluru?" — use profile city, never type the city name
  if (isResidingYesNoQuestion(raw)) {
    return residingYesNoAnswer(raw, profile);
  }

  // Free-text location / residence / preferred cities
  if (
    /where are you|current location|which city|city are you|your location|where do you live|based (in|out of)|present location|hometown/i.test(q)
    || isLinkedInCityQuestion(q)
  ) {
    return profile.currentLocation;
  }

  if (q.includes('preferred location') || q.includes('work location')) {
    return profile.currentLocation;
  }

  // Skills / languages / tools (never answer "Yes")
  if (
    /which (programming )?languages?|programming languages?|tech stack|technologies|tools have you|skills do you|key skills|technical skills|frameworks?/i.test(q)
    || (/languages?|technologies|frameworks|tools/i.test(q) && /used|know|worked|professional/i.test(q))
  ) {
    return skillsAnswer(profile);
  }

  // Rating / proficiency scales
  if (
    /rate your|proficiency|on a scale|scale of|1\s*[-–to/]\s*10|out of\s*10|\/\s*10/i.test(q)
    && !/%|percent|cgpa|marks/i.test(q)
  ) {
    return proficiencyRating(profile);
  }

  // Any experience / years question (any technology or tool) → profile total experience
  if (
    !/percent|cgpa|ctc|salary|notice|how old|age are you/i.test(q)
    && (
      /how many\s+(year|yr|years)|years?\s+of\s+(work\s+|total\s+|relevant\s+|relavent\s+)?experi|experi[ea]nce\s+in|experince|exp\s+in|total\s+exp|relevant\s+experi|relavent|hands.?on|professional\s+experi|working\s+experi|overall\s+experi|years of experi/i.test(q)
      || (
        /how many|years|experi[ea]nce|experince|exp\b|worked on|working on/i.test(q)
        && /[a-z]{2,}/i.test(q) // any tech/tool name or general experience ask
      )
    )
  ) {
    return experienceAnswer(profile);
  }

  // "Do you know X?" / "Have you worked with X?" → Yes (not for which/rate/how many)
  if (
    /\.net|dotnet|net core|c#|csharp|angular|react|javascript|typescript|node|nodejs|java|python|php|laravel|html|css|mongodb|sql|express|frontend|front end|backend|back end|full stack|fullstack|spring/i.test(q)
  ) {
    if (/rate|proficiency|1\s*[-–to/]\s*10/i.test(q)) return proficiencyRating(profile);
    if (/which|what languages|what tech/i.test(q)) return skillsAnswer(profile);
    if (/^(do you|have you|are you familiar|know)/i.test(q) || /familiar with|worked with|experience with/i.test(q)) {
      return 'Yes';
    }
  }
  if (q.includes('ctc') || q.includes('salary') || q.includes('lpa') || /lac|lakh/.test(q)) {
    if (asksLacs || /lac|lakh|lpa/.test(q)) {
      return ctcInLacs(profile.expectedCTC) ?? ctcInLacs(profile.currentCTC);
    }
    return ctcAbsoluteRupees(profile.expectedCTC)
      ?? ctcInLacs(profile.expectedCTC)
      ?? ctcInLacs(profile.currentCTC);
  }

  // Strict yes/no only — exclude where/which/what/how/rate free-text prompts
  const isBinaryYesNo =
    /^(are you|do you|have you|will you|can you|would you)\b/i.test(q)
    || /willing to|authorized|sponsorship|ready to relocate|currently living in|living in or ready|comfortable relocating|work from office|hybrid|night shift|face to face|background verification|\bbond\b|immediate joiner/i.test(q);

  if (isBinaryYesNo && !/where are you|which city|what |how many|rate |proficiency|languages|skills/i.test(q)) {
    if (/sponsor|visa/.test(q)) return profile.requiresSponsorship ? 'Yes' : 'No';
    if (isResidingYesNoQuestion(raw) || /relocat|living in|residing/.test(q)) {
      return residingYesNoAnswer(raw, profile);
    }
    if (/authoriz|work permit|eligible/.test(q)) return profile.workAuthorization === 'No' ? 'No' : 'Yes';
    return 'Yes';
  }

  // Comfortable / office / commute / hybrid style yes-no
  if (/comfortable|hybrid|commut|come to (our )?office|willing to (come|work|join)|ok with|okay with/i.test(q)
    && !/where|which|what|how many|rate/i.test(q)) {
    return 'Yes';
  }

  if (
    q.includes('reason for change')
    || q.includes('reason for job change')
    || q.includes('why looking')
    || q.includes('why do you want')
  ) {
    return 'Looking for a role that better matches my skills, growth goals, and long-term career plans.';
  }

  if (q.includes('github') || q.includes('portfolio')) {
    return profile.coverLetterTemplate ?? 'Will share on request.';
  }

  if (
    /why|tell us|describe|cover letter|additional information|briefly introduce|about yourself|summary/i.test(q)
  ) {
    return profile.coverLetterTemplate
      ?? 'I am interested in this role and believe my experience is a strong match.';
  }

  // Unknown free-text — only answer when we recognize the intent; never guess
  if (/\b(where|which|what)\b/i.test(q)) {
    if (/city|location|live|reside|based/i.test(q)) return profile.currentLocation;
    if (/skill|language|tech|tool|framework/i.test(q)) return skillsAnswer(profile);
  }
  if (/\b(how many|rate|score|level)\b/i.test(q)) {
    if (/rate|proficiency|1\s*[-–to/]\s*10/i.test(q)) return proficiencyRating(profile);
    return experienceAnswer(profile);
  }

  return undefined;
}

function findChatbotSendButton(scope: ParentNode, input?: HTMLElement | null): HTMLElement | null {
  const textBtn = findModalActionButton(scope);
  if (textBtn) return textBtn;

  const searchRoots: ParentNode[] = [scope];
  if (input?.parentElement) searchRoots.push(input.parentElement, input.parentElement.parentElement ?? input.parentElement);

  for (const root of searchRoots) {
    if (!root) continue;
    const nodes = root.querySelectorAll<HTMLElement>('button, [role="button"], a[class*="send"], .send-btn');
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const text = normalizeText(el.textContent ?? '');
      const cls = (el.className?.toString() ?? '').toLowerCase();
      const aria = el.getAttribute('aria-label')?.toLowerCase() ?? '';
      if (text === 'send' || cls.includes('send') || aria.includes('send') || el.classList.contains('send-btn')) {
        return el;
      }
    }
    const submit = root.querySelector<HTMLElement>('button[type="submit"]');
    if (submit && isVisible(submit)) return submit;
  }
  return null;
}

function getNaukriQuestionModal(): ParentNode | null {
  const container = findNaukriChatbotContainer();
  if (container) return container;

  const chatInput = findNaukriChatInput(document);
  if (chatInput && !isNonRecruiterNaukriWidget(chatInput)) {
    const scope = getChatbotScopeFromInput(chatInput);
    if (scope instanceof HTMLElement) {
      const text = (scope.innerText || '').slice(0, 2000);
      if (containerLooksLikeRecruiterChat(text) || isInsideGenuineNaukriChatbot(chatInput)) {
        return scope;
      }
    }
  }

  const dialogs = document.querySelectorAll('[role="dialog"]');
  for (const node of dialogs) {
    const el = node as HTMLElement;
    if (!isVisible(el)) continue;
    if (el.querySelector('#apply-button, button#apply-button')) continue;
    const text = (el.innerText || '').slice(0, 2000);
    if (isNaukriPromoWidgetText(text)) continue;
    if (!containerLooksLikeRecruiterChat(text)) continue;
    if (!findModalActionButton(el)) continue;
    if (el.querySelectorAll('input[type="radio"], input:not([type="hidden"]):not([type="file"]), select, textarea, input[type="checkbox"]').length > 0) {
      return el;
    }
  }
  return null;
}

function getNaukriChatbotRoot(): ParentNode | null {
  return getNaukriQuestionModal();
}

/**
 * Naukri saveApply URLs encode result in multiApplyResp:
 *   {"jobId":200} = success (green "Applied to ...")
 *   {"jobId":406} = incomplete / not accepted (red Oops banner)
 */
function parseNaukriMultiApplyResp(): { jobId: string; code: number } | null {
  try {
    const href = window.location.href;
    const raw = new URL(href).searchParams.get('multiApplyResp');
    if (!raw) {
      // Sometimes present in hash or already-decoded query
      const m = href.match(/multiApplyResp=([^&]+)/i);
      if (!m) return null;
      const decoded = decodeURIComponent(m[1]);
      const obj = JSON.parse(decoded) as Record<string, number>;
      const [[jobId, code]] = Object.entries(obj);
      return { jobId, code: Number(code) };
    }
    const obj = JSON.parse(raw) as Record<string, number>;
    const entries = Object.entries(obj);
    if (entries.length === 0) return null;
    const [jobId, code] = entries[0];
    return { jobId, code: Number(code) };
  } catch {
    return null;
  }
}

/** 409xxx means Naukri already has an application for this job — not a failure. */
function isNaukriAlreadyAppliedCode(code: number): boolean {
  if (!Number.isFinite(code)) return false;
  return code === 409 || Math.floor(code / 1000) === 409;
}

/** The response must belong to the job we are on — stale banners must not blame another job. */
function naukriApplyRespMatchesCurrentJob(resp: { jobId: string; code: number }): boolean {
  const stateUrl = loadNaukriState()?.currentDetailUrl;
  const currentId = stateUrl ? naukriJobIdFromUrl(stateUrl) : null;
  if (!currentId || !resp.jobId) return true;
  return resp.jobId.includes(currentId) || currentId.includes(resp.jobId);
}

/** Incomplete / rejected apply (multiApplyResp 406, Oops banner, Naukri processing error). */
function detectNaukriApplyRejected(): boolean {
  const resp = parseNaukriMultiApplyResp();
  if (resp && Number.isFinite(resp.code)) {
    if (!naukriApplyRespMatchesCurrentJob(resp)) return false;
    if (resp.code === 200 || isNaukriAlreadyAppliedCode(resp.code)) return false;
    return true;
  }

  // Banner text only counts on Naukri's post-apply page — never a leftover banner on a listing
  if (!isNaukriPostApplyUrl(window.location.href)) return false;

  const text = (document.body?.innerText || '').slice(0, 3000).toLowerCase();
  return text.includes('application was not accepted')
    || text.includes('incomplete information')
    || text.includes('answer all mandatory questions')
    || text.includes('oops! your application was not accepted')
    || text.includes('error while processing your job application');
}

/** True when Naukri says this job was already applied to (409xxx). */
function detectNaukriAlreadyAppliedCode(): boolean {
  const resp = parseNaukriMultiApplyResp();
  if (!resp || !naukriApplyRespMatchesCurrentJob(resp)) return false;
  return isNaukriAlreadyAppliedCode(resp.code);
}

/** Human-readable reason for a rejected apply, so the report says what actually happened. */
function naukriApplyRejectionReason(): string {
  const text = (document.body?.innerText || '').slice(0, 3000).toLowerCase();
  if (text.includes('error while processing your job application')) {
    return 'Naukri could not process the application — apply manually';
  }
  const resp = parseNaukriMultiApplyResp();
  if (resp && Number.isFinite(resp.code) && resp.code !== 200) {
    return `Application not accepted — unanswered questions (code ${resp.code})`;
  }
  return 'Application not accepted — unanswered questions';
}

/** True only for successful saveApply / Applied banner (multiApplyResp 200 or already-applied). */
function detectNaukriApplyAcceptedPage(): boolean {
  const resp = parseNaukriMultiApplyResp();
  if (resp && naukriApplyRespMatchesCurrentJob(resp)) {
    return resp.code === 200 || isNaukriAlreadyAppliedCode(resp.code);
  }

  // Fallback: green success banner copy (image 4) — not the Oops incomplete banner
  if (detectNaukriApplyRejected()) return false;
  const text = (document.body?.innerText || '').slice(0, 2500);
  const lower = text.toLowerCase();
  if (lower.includes('application was not accepted') || lower.includes('incomplete information')) {
    return false;
  }
  // "Applied to \"Job Title\"" success banner
  if (/applied to\s*["“']/i.test(text)) return true;
  if (lower.includes('start your interview preparation') && lower.includes('applied to')) return true;
  return false;
}

/** Naukri often navigates to a confirmation / my-apply page instead of flipping the job button to green. */
function isNaukriApplyConfirmationPage(): boolean {
  if (!window.location.hostname.includes('naukri.com')) return false;

  // Explicit reject codes / Oops banner — never confirmation
  if (detectNaukriApplyRejected()) return false;

  // multiApplyResp present — only 200 counts
  const resp = parseNaukriMultiApplyResp();
  if (resp) return resp.code === 200;

  if (detectNaukriApplyAcceptedPage()) return true;

  const path = (window.location.pathname || '').toLowerCase();
  const href = window.location.href.toLowerCase();

  // /myapply/saveApply without a 200 code is NOT success (can be 406 incomplete)
  if (path.includes('/myapply/saveapply') || href.includes('/myapply/saveapply')) {
    return false;
  }

  // Other post-apply destinations
  if (
    path.includes('/myapply')
    || path.includes('/applied')
    || path.includes('/application-status')
    || path.includes('/mnjuser/apply')
    || href.includes('applysuccess')
    || href.includes('apply-success')
    || href.includes('applicationsuccess')
  ) {
    return !href.includes('showacp') && detectNaukriApplyAcceptedPage();
  }

  // Still on a job listing page — never treat as confirmation URL
  if (isNaukriJobDetailPage() || isNaukriSearchPage()) return false;

  return detectNaukriApplyAcceptedPage();
}

/**
 * Chatbot completion — Naukri shows "Thank you for your responses" then redirects.
 * Do NOT treat ordinary page copy ("100+ applied") as success.
 */
function detectNaukriChatThankYou(): boolean {
  const roots: ParentNode[] = [];
  const chat = findNaukriChatbotContainer();
  if (chat) roots.push(chat);
  const modal = getNaukriQuestionModal();
  if (modal && modal !== chat) roots.push(modal);
  document.querySelectorAll('[role="dialog"]').forEach((n) => roots.push(n));
  if (roots.length === 0) roots.push(document.body);

  const thankYou = [
    'thank you for your response',
    'thank you for your responses',
    'thanks for your response',
    'thanks for your responses',
    'thank you for answering',
    'thanks for answering',
    'we have recorded your response',
    'responses have been submitted',
    'your responses have been',
  ];

  for (const root of roots) {
    const text = ((root as HTMLElement).innerText || (root as HTMLElement).textContent || '')
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .slice(0, 4000);
    if (thankYou.some((s) => text.includes(s))) return true;
  }
  return false;
}

/** True while recruiter Q&A UI still needs answers — never count Applied in this state. */
function naukriRecruiterQuestionsPending(): boolean {
  if (detectNaukriChatThankYou()) return false;
  if (pageHasRecruiterChatbot() || getNaukriQuestionModal() || findNaukriChatInput(document)) {
    // Chat open with unanswered choice/input still counts as pending
    const scope = findNaukriChatbotContainer() ?? getNaukriQuestionModal() ?? document.body;
    const choices = collectNaukriChoiceOptions(scope as ParentNode);
    const q = extractRecruiterQuestionFromPage(scope as ParentNode);
    if (q && q.length >= 8 && !isNaukriDisclaimerOrNote(q)) return true;
    if (choices.length > 0) return true;
    if (findNaukriChatInput(document)) return true;
    // Greeting / loading chat without a question yet — still pending
    const text = ((scope as HTMLElement).innerText || '').toLowerCase();
    if (text.includes('kindly answer') || text.includes("recruiter's questions") || text.includes('type message')) {
      return true;
    }
  }
  return false;
}

/**
 * Strict success detection. Must NOT match listing copy like "100+ applicants have applied".
 * While recruiter questions are open, always returns false.
 * saveApply with multiApplyResp!=200 (e.g. 406 incomplete) is NEVER success.
 */
function detectNaukriApplySuccess(): boolean {
  if (detectNaukriApplyRejected()) return false;
  if (naukriRecruiterQuestionsPending()) return false;

  // URL / banner: only multiApplyResp 200 or green "Applied to ..."
  if (detectNaukriApplyAcceptedPage()) return true;

  // Strongest on job page: primary CTA flipped to Applied
  if (naukriPrimaryApplyLooksApplied() || headerShowsAppliedBadge()) return true;

  // Confirmation page helper (already excludes 406)
  if (isNaukriApplyConfirmationPage()) return true;

  // Chat thank-you alone is NOT enough — wait for redirect / Applied banner
  // (thank-you is handled by waitForApplyOutcome)

  // Toast / snackbar only (short visible alerts)
  for (const el of document.querySelectorAll<HTMLElement>(
    '[class*="toast"], [class*="Toast"], [class*="snack"], [class*="Snack"], [class*="notify"], [role="alert"], [class*="snackbar"]',
  )) {
    if (!isVisible(el)) continue;
    const t = normalizeText(el.textContent ?? '');
    if (!t || t.length > 180) continue;
    if (t.includes('not accepted') || t.includes('incomplete')) continue;
    if (
      t.includes('successfully applied')
      || t.includes('applied successfully')
      || t.includes('application submitted')
      || t.includes('application sent')
      || t.includes('thank you for applying')
      || /^applied to\b/.test(t)
    ) {
      return true;
    }
  }

  return false;
}

function headerShowsAppliedBadge(): boolean {
  if (naukriPrimaryApplyLooksApplied()) return true;
  for (const el of document.querySelectorAll<HTMLElement>('button, a, [role="button"], span, div')) {
    if (!isVisible(el)) continue;
    const t = normalizeText(el.textContent ?? el.getAttribute('aria-label') ?? '');
    if (t !== 'applied' && t !== 'applied successfully' && !t.startsWith('applied ')) continue;
    const rect = el.getBoundingClientRect();
    // Header / job-actions Applied control (allow a bit lower on the page)
    if (rect.top < window.innerHeight * 0.7 && rect.width > 20 && rect.height > 10) return true;
  }
  return false;
}

async function waitForNaukriApplySuccess(timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs && !isStopped()) {
    if (detectNaukriApplySuccess() || isNaukriApplyConfirmationPage()) return true;
    await sleep(400);
  }
  return detectNaukriApplySuccess() || isNaukriApplyConfirmationPage();
}

function isAlreadyAppliedOnPage(): boolean {
  // Match ONLY "already applied to THIS job" — never the Naukri conflict toast
  // "You could not apply as you have already applied for other job"
  // which means another application is still in progress.
  // Do NOT use Applied badge here — callers treat that as successful apply.
  const nodes = document.querySelectorAll<HTMLElement>(
    '[role="alert"], [class*="toast" i], [class*="snack" i], [class*="notify" i], [class*="message" i], [class*="error" i], [class*="banner" i]',
  );
  for (const el of nodes) {
    const t = normalizeText(el.textContent ?? '');
    if (!t) continue;
    if (isNaukriOtherApplyInProgressMessage(t)) continue;
    if (
      /you have already applied( to this| for this)?( job| opening)?\b/.test(t)
      || /\balready applied to this (job|opening|position)\b/.test(t)
    ) {
      return true;
    }
  }

  // Body text fallback — exclude "other job" / "another application" conflict wording
  const text = (document.body?.innerText ?? '').toLowerCase();
  if (isNaukriOtherApplyInProgressMessage(text)) return false;
  return /you have already applied to this job|already applied to this (job|opening|position)|you have already applied for this (job|opening)/.test(text);
}

/** Naukri blocks a new Apply while a previous chatbot/apply is still open. */
function isNaukriOtherApplyInProgressMessage(text: string): boolean {
  const t = text.toLowerCase();
  return /already applied for other job/.test(t)
    || /already applied to (another|other) job/.test(t)
    || /another application (is )?(in progress|pending|open)/.test(t)
    || /complete (your |the )?previous (application|apply)/.test(t)
    || /finish (your |the )?current application/.test(t)
    || /could not apply as you have already applied/.test(t);
}

function pageShowsOtherApplyInProgress(): boolean {
  const text = (document.body?.innerText ?? '').toLowerCase();
  if (isNaukriOtherApplyInProgressMessage(text)) return true;
  for (const el of document.querySelectorAll<HTMLElement>('[role="alert"], [class*="toast" i], [class*="snack" i], [class*="notify" i]')) {
    if (isNaukriOtherApplyInProgressMessage(el.textContent ?? '')) return true;
  }
  return false;
}

async function dismissNaukriApplyConflictToasts(): Promise<void> {
  for (const el of document.querySelectorAll<HTMLElement>('button, a, [role="button"]')) {
    if (!isVisible(el)) continue;
    // Never press the chat's own close/X — that abandons the application
    if (isInsideNaukriChat(el)) continue;
    const t = normalizeText(el.textContent ?? el.getAttribute('aria-label') ?? '');
    if (t === 'ok' || t === 'close' || t === 'dismiss' || t === 'got it') {
      forceClick(el);
      await sleep(200);
    }
  }
}

/**
 * Naukri promo controls that must never be clicked as a chat action. "Send me jobs like this"
 * contains the word "send", which used to win the Save/Send match and created a job alert.
 */
function isPromoActionControl(el: HTMLElement): boolean {
  const text = normalizeText(el.textContent ?? el.getAttribute('value') ?? '');
  const meta = normalizeText(
    [el.getAttribute('aria-label'), el.getAttribute('title'), el.className?.toString()]
      .filter(Boolean)
      .join(' '),
  );
  const combined = `${text} ${meta}`;
  return /send me jobs|jobs like this|job alert|create alert|subscribe|notify me|modify|register|sign ?in|log ?in/i
    .test(combined);
}

function findModalActionButton(scope: ParentNode): HTMLElement | null {
  const labels = ['save', 'submit', 'send', 'next', 'done', 'continue'];
  const chatOpen = isNaukriChatOpen();
  const nodes = scope.querySelectorAll<HTMLElement>(
    'button, a, [role="button"], input[type="submit"], input[type="button"], div[class*="btn"], span[class*="btn"]',
  );
  let best: HTMLElement | null = null;
  let bestScore = 0;
  for (const el of nodes) {
    if (!isVisible(el)) continue;
    if (isJobBookmarkSaveControl(el)) continue;
    if (isPromoActionControl(el)) continue;
    // While the chat is open, only its own Save may be pressed
    if (chatOpen && !isInsideNaukriChat(el)) continue;
    const text = normalizeText(el.textContent ?? el.getAttribute('value') ?? '');
    if (!text || isApplyLabel(text) || isExternalApplyText(text)) continue;
    // Action buttons are short labels — a sentence containing "send" is not one
    if (text.length > 18) continue;
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i];
      const exact = text === l;
      const wordMatch = new RegExp(`\\b${l}\\b`).test(text);
      if (!exact && !wordMatch) continue;
      const score = 100 - i * 10 + (exact ? 20 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
  }
  if (best) return best;

  for (const sel of ['[class*="save"]', '[class*="Save"]', '[class*="submit"]', 'button.btn-primary']) {
    const el = scope.querySelector<HTMLElement>(sel);
    if (!el || !isVisible(el)) continue;
    if (isJobBookmarkSaveControl(el)) continue;
    if (isPromoActionControl(el)) continue;
    if (chatOpen && !isInsideNaukriChat(el)) continue;
    const text = normalizeText(el.textContent ?? '');
    if (!text || isApplyLabel(text) || text.includes('apply now') || text.length > 18) continue;
    if (labels.some((l) => new RegExp(`\\b${l}\\b`).test(text))) return el;
  }
  return null;
}

function findVisibleDialogForScope(scope: ParentNode): HTMLElement | null {
  if (scope instanceof HTMLElement) {
    const dialog = scope.closest<HTMLElement>('[role="dialog"]');
    if (dialog && isVisible(dialog)) return dialog;
  }

  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))
    .filter((el) => isVisible(el));
  if (dialogs.length === 0) return null;
  dialogs.sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return (br.width * br.height) - (ar.width * ar.height);
  });
  return dialogs[0];
}

/**
 * The Save that submits a chat answer. The listing's own Save (bookmark) sits next to
 * Apply and is outside the chat — clicking it would close the chat, so it is never used.
 */
function findNaukriSaveButton(scope: ParentNode): HTMLElement | null {
  const chat = getOpenNaukriChatContainer();
  const roots: ParentNode[] = [];
  if (chat) roots.push(chat);
  if (!roots.includes(scope)) roots.push(scope);
  const dialog = findVisibleDialogForScope(scope);
  if (dialog && !roots.includes(dialog)) roots.push(dialog);

  for (const root of roots) {
    const action = findModalActionButton(root);
    if (!action) continue;
    if (isJobBookmarkSaveControl(action)) continue;
    if (chat && !isInsideNaukriChat(action)) continue;
    return action;
  }

  // Chat open: never search the whole page — that is how the listing Save got clicked
  if (chat) return null;

  const candidates = Array.from(document.querySelectorAll<HTMLElement>(
    'button, [role="button"], input[type="submit"], input[type="button"], div, span',
  ));
  const visible = candidates.filter((el) => {
    if (!isVisible(el)) return false;
    if (isJobBookmarkSaveControl(el)) return false;
    const text = normalizeText(el.textContent ?? el.getAttribute('value') ?? '');
    if (text !== 'save' && text !== 'submit' && text !== 'next' && text !== 'continue') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 40 && rect.height > 20;
  });
  if (visible.length === 0) return null;
  visible.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
  return visible[0];
}

async function clickNaukriSaveButton(
  scope: ParentNode,
  jobTitle?: string,
  company?: string,
  maxAttempts = 2,
): Promise<boolean> {
  const beforeQuestion = getModalQuestionText(scope);

  for (let attempt = 0; attempt < maxAttempts && !isStopped(); attempt++) {
    let action = findNaukriSaveButton(scope) ?? findModalActionButton(scope);

    // Chat open but Save not rendered yet — give it time instead of pressing Enter blindly
    if (!action && isNaukriChatOpen()) {
      for (let wait = 0; wait < 6 && !action && !isStopped(); wait++) {
        await sleep(500);
        action = findNaukriSaveButton(scope) ?? findModalActionButton(scope);
      }
    }

    if (action) {
      const label = action.textContent?.trim() || action.getAttribute('value') || 'Save';
      emit({ status: 'searching', jobTitle, company, reason: `Clicking ${label} in chat...` });

      if (action instanceof HTMLButtonElement && action.disabled) {
        action.disabled = false;
        action.removeAttribute('disabled');
      }
      action.removeAttribute('aria-disabled');
      action.classList.remove('disabled');

      action.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
      await sleep(250);
      clickElementCenter(action);
      forceClick(action);
      await sleep(1200);
    } else {
      emit({ status: 'searching', jobTitle, company, reason: 'Pressing Enter to submit...' });
      pressEnterOnModal(scope);
      await sleep(800);
    }

    if (detectNaukriApplySuccess() || isAlreadyAppliedOnPage()) return true;

    let currentScope = getNaukriQuestionModal();
    if (!currentScope) return true;
    let afterQuestion = getModalQuestionText(currentScope);
    if (afterQuestion && beforeQuestion && afterQuestion !== beforeQuestion) return true;

    // Question unchanged — one Enter fallback, then stop (avoid Save/Enter spam loop)
    if (attempt === 0) {
      emit({ status: 'searching', jobTitle, company, reason: 'Pressing Enter to submit...' });
      pressEnterOnModal(scope);
      await sleep(400);
      currentScope = getNaukriQuestionModal();
      if (!currentScope) return true;
      afterQuestion = getModalQuestionText(currentScope ?? scope);
      if (afterQuestion && beforeQuestion && afterQuestion !== beforeQuestion) return true;
    }
  }

  return false;
}

function getCheckboxLabel(cb: HTMLInputElement): string {
  if (cb.getAttribute('aria-label')) {
    return (cb.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  }
  const forLab = cb.id
    ? document.querySelector<HTMLElement>(`label[for="${cb.id}"]`)
    : null;
  const wrap = forLab ?? (cb.closest('label') as HTMLElement | null);
  if (wrap) {
    const clone = wrap.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('input, svg, button, img').forEach((n) => n.remove());
    const t = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    if (t && t.length <= 60) return t;
  }
  const next = cb.nextElementSibling?.textContent?.replace(/\s+/g, ' ').trim();
  if (next && next.length <= 60) return next;
  const prev = cb.previousElementSibling?.textContent?.replace(/\s+/g, ' ').trim();
  if (prev && prev.length <= 60) return prev;
  return (cb.value || '').trim();
}

function fillNaukriCheckboxes(scope: ParentNode, questionText: string, jobTitle?: string): boolean {
  let changed = false;
  const q = questionText.toLowerCase();
  const keywords = (jobTitle ?? '').toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const checkboxes = scope.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');

  for (const cb of checkboxes) {
    if (cb.checked) continue;
    const label = getCheckboxLabel(cb).toLowerCase();

    const shouldCheck =
      /agree|accept|confirm|terms|declaration|consent|acknowledge/i.test(label)
      || /agree|accept|confirm|select all/i.test(q)
      || /^yes\b/.test(label)
      || (label.includes('yes') && !label.includes('no'))
      || keywords.some((k) => label.includes(k))
      || (/skill|technology|proficien|expertise|select/i.test(q) && label.length > 1);

    if (shouldCheck) {
      forceClick(cb);
      changed = true;
    }
  }

  scope.querySelectorAll<HTMLElement>('[role="checkbox"][aria-checked="false"]').forEach((el) => {
    const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').toLowerCase();
    if (/agree|accept|yes|confirm/i.test(label)) {
      forceClick(el);
      changed = true;
    }
  });

  return changed;
}

async function waitForApplyOutcome(
  profile: Profile,
  timeoutMs = 30000,
  jobTitle?: string,
  company?: string,
): Promise<'applied' | 'already' | 'timeout'> {
  const start = Date.now();
  let chatAttempts = 0;
  let hadChat = false;
  let sawThankYou = false;
  let otherApplyWaits = 0;

  while (Date.now() - start < timeoutMs && !isStopped()) {
    // Naukri already has an application for this job — success, not a rejection
    if (detectNaukriAlreadyAppliedCode()) return 'applied';

    // Incomplete apply (multiApplyResp 406 / Oops banner) — never count as Applied
    if (detectNaukriApplyRejected()) {
      emit({
        status: 'searching',
        jobTitle,
        company,
        reason: 'Application rejected — incomplete questions (not counted as Applied)',
      });
      return 'timeout';
    }

    // Never count success while questions are still on screen
    if (naukriRecruiterQuestionsPending()) {
      hadChat = true;
      if (chatAttempts === 0) {
        emit({
          status: 'searching',
          jobTitle,
          company,
          reason: 'Recruiter questions detected — answering chatbot...',
        });
      }
      chatAttempts++;
      const chatResult = await fillNaukriChatbot(profile, jobTitle, company);
      if (chatResult === 'stuck') {
        emit({
          status: 'searching',
          jobTitle,
          company,
          reason: 'Could not complete recruiter questions — will skip this job (not reopen)',
        });
        return 'timeout';
      }
      if (detectNaukriChatThankYou()) {
        sawThankYou = true;
        emit({
          status: 'searching',
          jobTitle,
          company,
          reason: 'Thank-you received — waiting for success page...',
        });
      } else if (chatResult === 'progress' && isNaukriChatOpen()) {
        // More questions may still be loading — never leave the chat before the thank-you
        emit({
          status: 'searching',
          jobTitle,
          company,
          reason: 'Chat still open — waiting for the next recruiter question...',
        });
        await sleep(2000);
      }
      await sleep(1200);
      continue;
    }

    if (detectNaukriChatThankYou()) {
      sawThankYou = true;
      emit({
        status: 'searching',
        jobTitle,
        company,
        reason: 'Thank-you for responses — waiting for redirect / Applied...',
      });
      // Naukri usually redirects after thank-you — give it time
      if (await waitForNaukriApplySuccess(12000)) return 'applied';
      if (headerShowsAppliedBadge() || naukriPrimaryApplyLooksApplied()) return 'applied';
      if (isNaukriApplyConfirmationPage()) return 'applied';
      // Thank-you alone on detail without redirect — wait a bit more, then accept if Apply flipped
      await sleep(2000);
      if (headerShowsAppliedBadge() || naukriPrimaryApplyLooksApplied() || isNaukriApplyConfirmationPage()) {
        return 'applied';
      }
      // Still on detail with thank-you and no questions → treat as applied
      if (!naukriRecruiterQuestionsPending() && !isApplyButtonStillOnPage()) return 'applied';
      if (!naukriRecruiterQuestionsPending() && (naukriPrimaryApplyLooksApplied() || headerShowsAppliedBadge())) {
        return 'applied';
      }
    }

    // Strict success only (no body-text false positives)
    if (detectNaukriApplySuccess()) return 'applied';
    if (headerShowsAppliedBadge() || naukriPrimaryApplyLooksApplied()) return 'applied';
    if (isNaukriApplyConfirmationPage()) return 'applied';

    // Transient Naukri conflict — wait; do NOT treat as "already applied to this job"
    if (pageShowsOtherApplyInProgress()) {
      otherApplyWaits++;
      if (otherApplyWaits <= 4) {
        emit({
          status: 'searching',
          jobTitle,
          company,
          reason: 'Naukri says another apply is in progress — waiting, then continuing...',
        });
        await dismissNaukriApplyConflictToasts();
        await sleep(2000);
        if (pageHasRecruiterChatbot() || getNaukriQuestionModal()) {
          const mid = await fillNaukriChatbot(profile, jobTitle, company);
          if (mid === 'stuck') return 'timeout';
        }
        continue;
      }
    }

    if (isAlreadyAppliedOnPage()) return 'already';

    // Left job detail for a real confirmation URL (not search, not guessing)
    if (!isNaukriJobDetailPage() && !isNaukriSearchPage()) {
      if (isNaukriApplyConfirmationPage() || detectNaukriApplySuccess()) return 'applied';
      if (sawThankYou || hadChat) {
        // After chat, a non-search redirect is usually success — verify strong signals
        await sleep(1000);
        if (isNaukriApplyConfirmationPage() || detectNaukriApplySuccess() || headerShowsAppliedBadge()) {
          return 'applied';
        }
        const text = (document.body?.innerText || '').slice(0, 2000).toLowerCase();
        if (
          text.includes('successfully applied')
          || text.includes('application submitted')
          || text.includes('thank you for applying')
          || text.includes('application sent')
        ) {
          return 'applied';
        }
      }
    }

    // Chat closed — wait for thank-you / Applied / redirect (do NOT assume success)
    if (hadChat && !naukriRecruiterQuestionsPending()) {
      emit({
        status: 'searching',
        jobTitle,
        company,
        reason: 'Chat closed — waiting for thank-you or Applied confirmation...',
      });
      const confirmed = await waitForNaukriApplySuccess(10000);
      if (confirmed || headerShowsAppliedBadge() || naukriPrimaryApplyLooksApplied() || isNaukriApplyConfirmationPage()) {
        return 'applied';
      }
      if (detectNaukriChatThankYou()) {
        sawThankYou = true;
        continue;
      }
      // Chat vanished without confirmation — keep waiting until timeout (may reopen questions)
      await sleep(800);
      if (naukriRecruiterQuestionsPending()) continue;
      // If Apply is still available, application did not complete
      if (isApplyButtonStillOnPage() && !naukriPrimaryApplyLooksApplied()) {
        return 'timeout';
      }
    }

    await sleep(500);
  }

  if (naukriRecruiterQuestionsPending()) return 'timeout';
  if (detectNaukriApplySuccess() || isNaukriApplyConfirmationPage() || headerShowsAppliedBadge() || naukriPrimaryApplyLooksApplied()) {
    return 'applied';
  }
  if (sawThankYou && !isApplyButtonStillOnPage()) return 'applied';
  if (isAlreadyAppliedOnPage() && !pageShowsOtherApplyInProgress()) return 'already';
  return 'timeout';
}

async function finalizeNaukriApplication(state: NaukriRunState): Promise<void> {
  const url = state.currentDetailUrl ?? normalizeJobUrl(window.location.href);
  sessionStorage.removeItem(`job-autoapply-bounce-${state.runId}-${normalizeJobUrl(url)}`);
  const finalizedKey = `job-autoapply-finalized-${state.runId}-${url}`;
  if (sessionStorage.getItem(finalizedKey)) return;
  sessionStorage.setItem(finalizedKey, '1');
  sessionStorage.removeItem(`job-autoapply-post-apply-${state.runId}`);

  clearNaukriConsecutiveRateLimits(state);
  markJobProcessed(state, url);
  state.counts.applied++;
  recordAppliedLead(state.jobTitle, state.company, url);
  emit({ status: 'applied', jobTitle: state.jobTitle, company: state.company });
  saveNaukriState(state);

  if (hasReachedApplyCap(state)) {
    finish(state.counts);
    return;
  }

  await randomDelay(1500, 2500);
  returnToNaukriSearch(state, state.jobIndex + 1);
}

function getJobMeta(card: HTMLElement): { title: string; company: string } {
  const title =
    card.querySelector('.title, a.title, [class*="title"] a, a[href*="job-listings"]')?.textContent?.trim()
    ?? 'Unknown';
  const company =
    card.querySelector('.comp-name, .subTitle, [class*="comp-name"], [class*="company"]')?.textContent?.trim()
    ?? 'Unknown';
  return { title, company };
}

/** Give up on a chat that shows no new question / thank-you for this long. */
const NAUKRI_CHAT_IDLE_MS = 15000;

async function fillNaukriChatbot(profile: Profile, jobTitle?: string, company?: string): Promise<'applied' | 'progress' | 'stuck'> {
  let lastQuestion = '';
  let sameQuestionCount = 0;
  let unreadQuestionCount = 0;
  let madeProgress = false;
  let lastActivityAt = Date.now();
  const noteActivity = () => {
    lastActivityAt = Date.now();
  };

  // The chat is only done when Naukri replies "Thank you for your responses" — keep answering until then
  for (let step = 0; step < 30 && !isStopped(); step++) {
    try {
      // Nothing moved for 15s — stop waiting and let the run continue with the next job
      if (Date.now() - lastActivityAt > NAUKRI_CHAT_IDLE_MS) {
        emit({
          status: 'searching',
          jobTitle,
          company,
          reason: 'No chat activity for 15s — moving to the next job',
        });
        return madeProgress ? 'progress' : 'stuck';
      }
      // Strict success only — never while questions remain
      if (detectNaukriChatThankYou() && !naukriRecruiterQuestionsPending()) {
        emit({
          status: 'searching',
          jobTitle,
          company,
          reason: 'Chat thank-you seen — waiting for Applied confirmation...',
        });
        if (await waitForNaukriApplySuccess(10000) || headerShowsAppliedBadge() || naukriPrimaryApplyLooksApplied()) {
          return 'applied';
        }
        // Thank-you without more questions — progress; caller waits for redirect
        return 'progress';
      }
      if (detectNaukriApplySuccess() && !naukriRecruiterQuestionsPending()) return 'applied';

      let chatInput = findNaukriChatInput(document);
      if (!chatInput) {
        await sleep(500);
        chatInput = findNaukriChatInput(document);
      }

      // Everything below must run inside the real chat panel. Without this guard the run
      // scanned the job page and answered the job title / JD lines as recruiter questions.
      const chatContainer = getOpenNaukriChatContainer();
      if (!chatContainer) {
        await sleep(600);
        if (!getOpenNaukriChatContainer() && !detectNaukriChatThankYou()) {
          return madeProgress ? 'progress' : 'stuck';
        }
        continue;
      }
      const scope: ParentNode = chatContainer;
      const optionScope: ParentNode = chatContainer;

      let questionText = extractRecruiterQuestionFromPage(optionScope);

      const choiceOptions = collectNaukriChoiceOptions(optionScope);
      // Experience + "Type message here..." is free-text — do not treat Skip as a choice
      const hasChoices = hasRealSelectableChoices(choiceOptions, questionText || '', chatInput);

      // Infer question from visible options when history is polluted (CTC / notice typed earlier)
      if (hasChoices) {
        const labels = choiceOptions.map((o) => o.label.toLowerCase()).join(' || ');
        if (/will attend|yes,? i will attend|will not attend/i.test(labels) || (/^yes\b/.test(labels) && /walk-?\s*in/i.test(questionText || ''))) {
          if (!isWalkInAttendQuestion(questionText || '')) {
            questionText = 'Will you attend the walk-in?';
          }
        } else if (/no experience|<\s*1 year|1\s*[-–]\s*2|2\s*[-–]\s*3|>\s*3/.test(labels)) {
          if (!/how many years|experience/i.test(questionText || '')) {
            questionText = 'How many years of experience do you have?';
          }
        } else if (/^yes\b|^no\b/i.test(labels) && /relocat|living in|resid/i.test((optionScope as HTMLElement).innerText || questionText || '')) {
          if (!isResidingYesNoQuestion(questionText || '')) {
            questionText = 'Are you currently living in or ready to relocate?';
          }
        }
      }

      // Yes/No radio modal with no readable text yet — still try radios with a synthetic prompt
      if ((!questionText || questionText.length < 8) && hasChoices) {
        const radioText = ((optionScope instanceof HTMLElement ? optionScope : document.body).innerText ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300);
        if (/walk-?\s*in|attend|relocat|living in|bengaluru|bangalore|willing|ready to|authorized|sponsor|years of experience/i.test(radioText)) {
          questionText = radioText.includes('?')
            ? (radioText.match(/[^?]{8,220}\?/)?.[0] ?? 'Will you attend the walk-in?')
            : (/walk|attend/i.test(radioText)
              ? 'Will you attend the walk-in?'
              : (/year/i.test(radioText) ? 'How many years of experience?' : 'Are you ready to relocate?'));
        }
      }

      const readableQuestion = Boolean(questionText)
        && (questionText.length >= 8 || isStandaloneChatPrompt(questionText));
      if (!readableQuestion) {
        unreadQuestionCount++;
        emit({
          status: 'searching',
          jobTitle,
          company,
          reason: 'Could not read recruiter question — waiting...',
        });
        if (unreadQuestionCount >= 12) {
          emit({
            status: 'searching',
            jobTitle,
            company,
            reason: 'Could not read chatbot questions — moving on',
          });
          return madeProgress ? 'progress' : 'stuck';
        }
        await sleep(1200);
        continue;
      }
      unreadQuestionCount = 0;

      if (questionText && questionText === lastQuestion) {
        sameQuestionCount++;
      } else {
        sameQuestionCount = 0;
        noteActivity();
      }
      lastQuestion = questionText;

      // Stuck on the same question repeatedly — leave (avoid minutes of Save/Enter spam)
      if (sameQuestionCount >= 4) {
        emit({
          status: 'searching',
          jobTitle,
          company,
          reason: 'Same recruiter question unanswered twice — moving on',
        });
        return 'stuck';
      }

      const answer = mapChatbotAnswer(questionText, profile)
        ?? (hasChoices ? (preferredYesNoForQuestion(questionText, profile) === 'yes' ? 'Yes' : 'No') : undefined);

      // Informational notes ("Please note that we will reach out…") — acknowledge with Save/Continue
      if (!answer && !hasChoices && isNaukriDisclaimerOrNote(questionText)) {
        emit({
          status: 'searching',
          jobTitle,
          company,
          reason: `Acknowledging note: "${questionText.replace(/\s+/g, ' ').trim().slice(0, 70)}..."`,
        });
        await clickNaukriSaveButton(optionScope, jobTitle, company, 2);
        await sleep(600);
        if (detectNaukriApplySuccess() || isNaukriApplyConfirmationPage()) return 'applied';
        madeProgress = true;
        continue;
      }

      if (!answer && !hasChoices) {
        emit({
          status: 'searching',
          jobTitle,
          company,
          reason: `Unknown question — skipped (not guessing): "${questionText.replace(/\s+/g, ' ').trim().slice(0, 90)}"`,
        });
        return 'stuck';
      }

      const shortQ = questionText.replace(/\s+/g, ' ').trim().slice(0, 90);

      // Fast path: years-of-experience free-text — type profile years and Save once
      if (
        !hasChoices
        && chatInput
        && answer
        && /how many years|years of experience|experience (do you have|in)\b/i.test(questionText)
      ) {
        const years = experienceAnswer(profile);
        emit({
          status: 'searching',
          jobTitle,
          company,
          reason: `Answering experience: "${shortQ}" → ${years}`,
        });
        const submitted = await answerNaukriChatDirect(years, jobTitle, company);
        await sleep(600);
        if (detectNaukriApplySuccess() || isNaukriApplyConfirmationPage()) return 'applied';
        const after = extractRecruiterQuestionFromPage(optionScope);
        if (submitted || !after || after !== questionText) {
          madeProgress = true;
          continue;
        }
        // One MAIN-world retry only
        await answerNaukriChatViaMainWorld(years, questionText);
        await sleep(600);
        continue;
      }

      // Choice controls first — never fall through to typing CTC/Yes into chat
      if (hasChoices) {
        emit({
          status: 'searching',
          jobTitle,
          company,
          reason: `Selecting option for: "${shortQ}" (${choiceOptions.length} choices)`,
        });
        const selected = await selectNaukriQuestionOptions(optionScope, questionText, profile, jobTitle);
        await sleep(900);
        if (selected) {
          // Refuse to Save if the checkbox was toggled off (click/unclick bug)
          let anyChecked = collectNaukriChoiceOptions(optionScope).some(
            (o) => o.input?.checked || o.el.getAttribute('aria-checked') === 'true',
          );
          for (let retry = 0; retry < 2 && !anyChecked && !isStopped(); retry++) {
            emit({
              status: 'searching',
              jobTitle,
              company,
              reason: 'Option did not stay checked — retrying before Save...',
            });
            await selectNaukriQuestionOptions(optionScope, questionText, profile, jobTitle);
            await sleep(900);
            anyChecked = collectNaukriChoiceOptions(optionScope).some(
              (o) => o.input?.checked || o.el.getAttribute('aria-checked') === 'true',
            );
          }
          if (!anyChecked && choiceOptions.some((o) => o.input || o.el.getAttribute('role') === 'checkbox')) {
            emit({
              status: 'searching',
              jobTitle,
              company,
              reason: 'Checkbox still unchecked — not clicking Save yet',
            });
            await sleep(800);
            continue;
          }

          // Always the Save inside the chat — the listing Save (bookmark) is never touched
          await clickNaukriSaveButton(optionScope, jobTitle, company, 3);
          emit({
            status: 'searching',
            jobTitle,
            company,
            reason: 'Saved answer in chat — waiting for the next question or thank-you...',
          });

          const afterSaveStart = Date.now();
          let nextQuestionAppeared = false;
          while (Date.now() - afterSaveStart < NAUKRI_CHAT_IDLE_MS && !isStopped()) {
            if (detectNaukriChatThankYou()) {
              madeProgress = true;
              noteActivity();
              break;
            }
            if (detectNaukriApplySuccess() && !naukriRecruiterQuestionsPending()) return 'applied';
            const afterOpt = extractRecruiterQuestionFromPage(optionScope);
            if (afterOpt && afterOpt !== questionText && afterOpt.length >= 3) {
              emit({
                status: 'searching',
                jobTitle,
                company,
                reason: `Next question appeared: "${afterOpt.slice(0, 60)}..."`,
              });
              madeProgress = true;
              sameQuestionCount = 0;
              nextQuestionAppeared = true;
              noteActivity();
              break;
            }
            // Chat vanished without a thank-you: give Naukri time to redirect/confirm
            if (Date.now() - afterSaveStart > 8000 && !isNaukriChatOpen() && !pageHasRecruiterChatbot()) {
              madeProgress = true;
              noteActivity();
              break;
            }
            await sleep(700);
          }
          if (detectNaukriChatThankYou() || nextQuestionAppeared) {
            await sleep(700);
            continue;
          }
          if (!isNaukriChatOpen() && !pageHasRecruiterChatbot()) {
            emit({
              status: 'searching',
              jobTitle,
              company,
              reason: 'Chat closed without a thank-you — verifying the application result...',
            });
            madeProgress = true;
            noteActivity();
            await sleep(1500);
            continue;
          }
          // Save produced nothing new within the idle window — do not keep waiting
          emit({
            status: 'searching',
            jobTitle,
            company,
            reason: 'No reply after Save for 15s — moving to the next job',
          });
          return madeProgress ? 'progress' : 'stuck';
        } else {
          emit({
            status: 'searching',
            jobTitle,
            company,
            reason: 'Could not match a visible option — moving on',
          });
          return 'stuck';
        }
        continue;
      }

      emit({
        status: 'searching',
        jobTitle,
        company,
        reason: `Answering: "${shortQ}" → ${answer}`,
      });

      const formModal = isNaukriFormQuestionModal(optionScope) || isNaukriFormQuestionModal(scope);
      const emptyFormFields = Array.from(
        optionScope.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
          'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="file"]), select, textarea',
        ),
      ).filter((input) => {
        if (chatInput && input === chatInput) return false;
        if (isChatInputElement(input as HTMLElement)) return false;
        if (!isVisible(input as HTMLElement) && (input as HTMLElement).offsetParent === null) return false;
        const val = (input as HTMLInputElement).value?.trim() ?? '';
        return !val;
      });

      // Multi-field form without radio/chip choices
      if (formModal || emptyFormFields.length > 0) {
        let didFill = false;
        for (const input of emptyFormFields) {
          const container = (input.closest('div, label, form, li')?.textContent ?? questionText).toLowerCase();
          let value: string | undefined;
          if (/years of experience|total experience|relevant experience|total exp|how many years|experi[ea]nce in|experince/i.test(container)) {
            value = experienceAnswer(profile);
          } else if (container.includes('expected ctc') || (container.includes('ctc') && /lac|expect/.test(container))) {
            value = ctcInLacs(profile.expectedCTC) ?? ctcInLacs(profile.currentCTC);
          } else if (container.includes('current ctc') || container.includes('current salary')) {
            value = ctcInLacs(profile.currentCTC) ?? ctcInLacs(profile.expectedCTC);
          } else if (container.includes('notice')) {
            value = noticePeriodAnswer(profile, container);
          } else if (container.includes('phone') || container.includes('mobile')) {
            value = profile.phone;
          } else if (container.includes('email')) {
            value = profile.email;
          } else {
            value = mapChatbotAnswer(container, profile) ?? mapChatbotAnswer(questionText, profile);
          }
          if (value && !isWalkInAttendQuestion(container) && !isResidingYesNoQuestion(container)) {
            setReactInputValue(input as HTMLInputElement, value);
            didFill = true;
          }
        }
        if (await selectNaukriQuestionOptions(optionScope, questionText, profile, jobTitle)) didFill = true;
        await sleep(350);
        if (didFill) {
          madeProgress = true;
          await clickNaukriSaveButton(optionScope, jobTitle, company, 2);
          await sleep(500);
          if (detectNaukriApplySuccess() || isNaukriApplyConfirmationPage()) return 'applied';
          const afterForm = extractRecruiterQuestionFromPage(optionScope);
          if (!afterForm || afterForm !== questionText) continue;
          if (sameQuestionCount >= 1) return 'stuck';
          continue;
        }
      }

      // Free-text chat only when there are no choice controls
      if (chatInput && answer) {
        const submitted = await answerNaukriChatDirect(answer, jobTitle, company);
        await sleep(500);
        if (detectNaukriApplySuccess()) return 'applied';
        const afterDirect = getModalQuestionText(getNaukriQuestionModal() ?? scope);
        if (submitted || (afterDirect && afterDirect !== questionText)) {
          madeProgress = true;
          continue;
        }
      }

      if (answer) {
        const ok = await answerNaukriChatViaMainWorld(answer, questionText);
        await sleep(600);
        if (detectNaukriApplySuccess()) return 'applied';
        if (ok) {
          madeProgress = true;
          const again = findNaukriChatInput(document);
          if (again && getInputValue(again)) {
            await clickNaukriSaveButton(getChatbotScopeFromInput(again), jobTitle, company, 2);
            await submitChatAnswer(getChatbotScopeFromInput(again), again, jobTitle, company);
          }
          const afterMain = getModalQuestionText(getNaukriQuestionModal() ?? scope);
          if (!findNaukriChatInput(document) || (afterMain && afterMain !== questionText)) continue;
        }
      }

      if (!chatInput && !findNaukriChatInput(document)) {
        emit({ status: 'searching', jobTitle, company, reason: 'Waiting for chatbot input to appear...' });
        await sleep(800);
        continue;
      }

      const chatField = findNaukriChatInput(scope) ?? findNaukriChatInput(document) ?? chatInput;
      let didFill = false;
      const beforeQuestion = questionText;

      const fields = scope.querySelectorAll(
        'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="file"]), select, textarea',
      );
      for (const field of fields) {
        if (chatField && field === chatField) continue;
        const container = (field.closest('div, label, form, li')?.textContent ?? questionText).toLowerCase();
        const input = field as HTMLInputElement | HTMLSelectElement;
        if ((input as HTMLInputElement).type === 'file') continue;
        if ((input as HTMLInputElement).value?.trim()) continue;

        let value: string | undefined;
        if (container.includes('expected ctc') || container.includes('expected salary') || (container.includes('ctc') && container.includes('lac'))) {
          value = /lac|lakh|lpa/.test(container)
            ? ctcInLacs(profile.expectedCTC)
            : (ctcAbsoluteRupees(profile.expectedCTC) ?? ctcInLacs(profile.expectedCTC));
        } else if (container.includes('current ctc') || container.includes('current salary')) {
          value = /lac|lakh|lpa/.test(container)
            ? ctcInLacs(profile.currentCTC)
            : (ctcAbsoluteRupees(profile.currentCTC) ?? ctcInLacs(profile.currentCTC));
        } else if (container.includes('notice') || container.includes('last working day')) {
          if (input.tagName === 'SELECT') {
            const sel = input as HTMLSelectElement;
            for (const opt of sel.options) {
              if (profile.noticePeriod && opt.text.toLowerCase().includes(profile.noticePeriod.toLowerCase().slice(0, 4))) {
                sel.value = opt.value;
                break;
              }
            }
            input.dispatchEvent(new Event('change', { bubbles: true }));
            didFill = true;
            continue;
          }
          value = noticePeriodAnswer(profile, container);
        } else if (
          /years of experience|total experience|relevant experience|total exp|how many years|experi[ea]nce in|experince/i.test(container)
        ) {
          value = experienceAnswer(profile);
        } else if (container.includes('phone') || container.includes('mobile')) {
          value = profile.phone;
        } else if (container.includes('email')) {
          value = profile.email;
        } else if (isResidingYesNoQuestion(container) || isResidingYesNoQuestion(questionText) || isWalkInAttendQuestion(questionText)) {
          value = undefined;
        } else if (/current location|which city|where do you live|city are you/i.test(container)) {
          value = profile.currentLocation;
        } else if (container.includes('ctc') || container.includes('salary') || container.includes('lpa') || /lac|lakh/.test(container)) {
          value = /lac|lakh|lpa/.test(container)
            ? (ctcInLacs(profile.expectedCTC) ?? ctcInLacs(profile.currentCTC))
            : (ctcAbsoluteRupees(profile.expectedCTC) ?? ctcInLacs(profile.expectedCTC) ?? String(profile.currentCTC ?? ''));
        } else if (formModal) {
          value = mapChatbotAnswer(questionText, profile) ?? mapChatbotAnswer(container, profile);
        }

        if (value) {
          setReactInputValue(input as HTMLInputElement, value);
          didFill = true;
        }
      }

      // Form-modal choice controls (location checkboxes etc.)
      if (await selectNaukriQuestionOptions(optionScope, questionText, profile, jobTitle)) {
        didFill = true;
        madeProgress = true;
        await sleep(500);
        await clickNaukriSaveButton(optionScope, jobTitle, company, 2);
        if (detectNaukriApplySuccess()) return 'applied';
        const afterForm = extractRecruiterQuestionFromPage(optionScope);
        if (!afterForm || afterForm !== beforeQuestion) continue;
      }

      if (chatField && answer && !questionHasChoiceControls(optionScope)) {
        if (!getInputValue(chatField)) {
          setEditableValue(chatField, answer);
          await sleep(350);
          if (!getInputValue(chatField)) setEditableValue(chatField, answer);
          didFill = true;
        }
        if (getInputValue(chatField)) {
          await clickNaukriSaveButton(scope, jobTitle, company, 2);
          await submitChatAnswer(scope, chatField, jobTitle, company);
          if (detectNaukriApplySuccess()) return 'applied';
          madeProgress = true;
          await sleep(500);
          const nextQ = getModalQuestionText(getNaukriQuestionModal() ?? scope);
          if (nextQ && beforeQuestion && nextQ !== beforeQuestion) continue;
          continue;
        }
      }

      if (didFill || formModal) {
        const submitted = await clickNaukriSaveButton(scope, jobTitle, company, 2);
        if (detectNaukriApplySuccess()) return 'applied';
        if (submitted) {
          madeProgress = true;
          continue;
        }
      }

      if (pageHasRecruiterChatbot() || findNaukriChatInput(document)) {
        await sleep(500);
        continue;
      }
      if (!didFill) return madeProgress ? 'progress' : 'stuck';
    } catch (err) {
      emit({ status: 'searching', jobTitle, company, reason: `Form fill warning: ${(err as Error).message}` });
      return madeProgress ? 'progress' : 'stuck';
    }
  }
  if (detectNaukriApplySuccess() || isNaukriApplyConfirmationPage()) return 'applied';
  return madeProgress ? 'progress' : 'stuck';
}

function returnToNaukriSearch(state: NaukriRunState, nextIndex: number): void {
  if (isStopped()) {
    finish(state.counts);
    return;
  }
  state.jobIndex = nextIndex;
  state.phase = 'list';
  state.jobTitle = undefined;
  state.company = undefined;
  state.currentDetailUrl = undefined;
  saveNaukriState(state);
  releasePageClaim();
  sessionStorage.removeItem(EXEC_KEY);
  const target = naukriSearchUrlFor(state);
  if (!target || target.includes('/undefined')) {
    emit({ status: 'failed', reason: 'Could not build a valid Naukri search URL' });
    finish(state.counts);
    return;
  }
  window.location.href = target;
}

async function applyOnNaukriDetailPage(profile: Profile, state: NaukriRunState): Promise<void> {
  const jobTitle = state.jobTitle ?? 'Unknown';
  const company = state.company ?? 'Unknown';
  const currentUrl = normalizeJobUrl(window.location.href);
  const listingUrl = resolveNaukriListingUrl(state.currentDetailUrl || currentUrl);

  if (isStopped()) {
    finish(state.counts);
    return;
  }

  // Stray clicks sometimes open the account drawer — close it before any Apply/chat work
  dismissNaukriProfileDrawer();
  await sleep(200);

  // Never reopen a job we already skipped/failed/applied
  if (
    isNaukriJobHandled(state, listingUrl, jobTitle, company)
    || isNaukriJobHandled(state, state.currentDetailUrl, jobTitle, company)
  ) {
    markJobProcessed(state, listingUrl);
    emit({ status: 'skipped', jobTitle, company, reason: 'Already handled this job — moving to next' });
    releasePageClaim();
    returnToNaukriSearch(state, state.jobIndex + 1);
    return;
  }

  // Recruiter Yes/No / chatbot already open (e.g. Uplers relocate modal) — answer it first.
  // Never treat this as "Repeated open after error".
  if (hasGenuineRecruiterChat()) {
    emit({
      status: 'searching',
      jobTitle,
      company,
      reason: 'Recruiter questions already open — answering before Apply check...',
    });
    sessionStorage.setItem(`job-autoapply-post-apply-${state.runId}`, '1');
    const chatOutcome = await waitForApplyOutcome(profile, 45000, jobTitle, company);
    if (chatOutcome === 'applied') {
      await finalizeNaukriApplication(state);
      return;
    }
    if (detectNaukriApplySuccess() || headerShowsAppliedBadge() || naukriPrimaryApplyLooksApplied()) {
      await finalizeNaukriApplication(state);
      return;
    }
    // Still stuck on unanswered questions — skip once, do NOT reopen 7–8 times
    if (pageHasRecruiterChatbot() || getNaukriQuestionModal()) {
      const stuck = await fillNaukriChatbot(profile, jobTitle, company);
      await sleep(800);
      if (stuck === 'applied' || detectNaukriApplySuccess() || headerShowsAppliedBadge() || naukriPrimaryApplyLooksApplied()) {
        await finalizeNaukriApplication(state);
        return;
      }
      if (stuck === 'stuck' || pageHasRecruiterChatbot() || getNaukriQuestionModal()) {
        skipNaukriJobAndAdvance(
          state,
          'Could not answer recruiter questions — skipped (will not reopen)',
          listingUrl,
        );
        return;
      }
    }
  }

  // Let the SPA finish painting Apply / company-site CTAs before declaring the page dead.
  // Root cause of false "Repeated open": open-count was checked before Apply rendered.
  await sleep(1200);
  let ready = await waitForExternalOrNormalApply(6000);
  let applyStillThere = Boolean(ready.apply ?? findNaukriApplyButtonSync());
  let companySiteBtn = ready.external ?? findExternalApplyControl();
  let chatStillOpen = pageHasRecruiterChatbot() || Boolean(getNaukriQuestionModal()) || Boolean(findNaukriChatInput(document));

  const openKey = `job-autoapply-open-count-${normalizeJobUrl(state.currentDetailUrl || listingUrl)}`;
  const openCount = Number(sessionStorage.getItem(openKey) || '0');

  // Company-website Apply was missed before and burned open-count — capture it now
  if (companySiteBtn && !applyStillThere) {
    await captureNaukriCompanySiteApply(state, jobTitle, company, listingUrl || currentUrl, companySiteBtn);
    return;
  }

  // Only skip on high open-count when the posting is truly dead AFTER waiting for UI
  if (openCount >= NAUKRI_MAX_JOB_OPENS - 1 && !applyStillThere && !companySiteBtn && !chatStillOpen && !isApplyButtonStillOnPage()) {
    await sleep(1500);
    ready = await waitForExternalOrNormalApply(4000);
    applyStillThere = Boolean(ready.apply ?? findNaukriApplyButtonSync());
    companySiteBtn = ready.external ?? findExternalApplyControl();
    chatStillOpen = pageHasRecruiterChatbot() || Boolean(getNaukriQuestionModal()) || Boolean(findNaukriChatInput(document));
  }

  if (openCount >= NAUKRI_MAX_JOB_OPENS - 1 && !applyStillThere && !companySiteBtn && !chatStillOpen && !isApplyButtonStillOnPage()) {
    skipNaukriJobAndAdvance(state, `Repeated open after error — skipped (${openCount} opens)`, listingUrl);
    return;
  }

  // Still applyable after prior opens — click Apply, do not skip
  if (openCount >= 2 && (applyStillThere || chatStillOpen || companySiteBtn)) {
    emit({
      status: 'searching',
      jobTitle,
      company,
      reason: applyStillThere
        ? 'Apply still available after prior opens — clicking Apply...'
        : chatStillOpen
          ? 'Questions still open after prior opens — continuing answers...'
          : 'Company-site Apply still available — capturing...',
    });
  }

  // Bad / 404 detail page: skip this job and move on immediately
  if (isNaukriErrorPage()) {
    skipNaukriJobAndAdvance(state, 'Naukri page error / 404', listingUrl);
    return;
  }

  // Naukri company-site confirmation (showAcp) — leave immediately; background owns URL capture
  if (isNaukriCompanySiteConfirmationPage()) {
    // Success page can share URL patterns — prefer counting the apply first
    if (detectNaukriApplySuccess() || headerShowsAppliedBadge()) {
      await finalizeNaukriApplication(state);
      return;
    }
    emit({
      status: 'searching',
      jobTitle,
      company,
      reason: 'Company-site confirmation reached — capturing company URL from new tab...',
    });
    notifyCompanyRedirectConfirmation(buildNaukriSearchUrl(state.criteria));
    return;
  }

  // Naukri already holds an application for this job (409xxx) — it succeeded, count it once
  if (detectNaukriAlreadyAppliedCode()) {
    emit({
      status: 'searching',
      jobTitle,
      company,
      reason: 'Naukri reports this job as already applied — counting it as applied',
    });
    await finalizeNaukriApplication(state);
    return;
  }

  // Incomplete apply redirect (multiApplyResp 406) — never count as Applied
  if (detectNaukriApplyRejected()) {
    skipNaukriJobAndAdvance(state, naukriApplyRejectionReason(), listingUrl);
    return;
  }

  // Landed on success/confirmation page after Apply navigation (often /myapply, not green Applied)
  if (isNaukriApplyConfirmationPage() || (detectNaukriApplySuccess() && !naukriRecruiterQuestionsPending())) {
    emit({
      status: 'searching',
      jobTitle,
      company,
      reason: 'Confirmation page after apply — counting as applied',
    });
    await finalizeNaukriApplication(state);
    return;
  }

  const postApplyPending = sessionStorage.getItem(`job-autoapply-post-apply-${state.runId}`) === '1';
  if (postApplyPending) {
    // Verification revisit: if Apply is still available, the previous click never applied
    if (
      isApplyButtonStillOnPage()
      && !naukriPrimaryApplyLooksApplied()
      && !headerShowsAppliedBadge()
      && !pageHasRecruiterChatbot()
      && !getNaukriQuestionModal()
    ) {
      emit({
        status: 'searching',
        jobTitle,
        company,
        reason: 'Apply still available after prior click — clicking Apply again...',
      });
      sessionStorage.removeItem(`job-autoapply-post-apply-${state.runId}`);
      // Fall through to normal apply click below
    } else {
      emit({ status: 'searching', jobTitle, company, reason: 'Waiting for apply confirmation...' });
      const outcome = await waitForApplyOutcome(profile, 25000, jobTitle, company);
      if (outcome === 'applied') {
        await finalizeNaukriApplication(state);
        return;
      }
      if (outcome === 'already') {
        skipNaukriJobAndAdvance(state, 'already applied to this company', currentUrl);
        return;
      }
      if (naukriPrimaryApplyLooksApplied() || headerShowsAppliedBadge() || detectNaukriApplySuccess()) {
        await finalizeNaukriApplication(state);
        return;
      }
      skipNaukriJobAndAdvance(state, 'could not confirm application after apply', currentUrl);
      return;
    }
  }

  // Critical: never soft-return on duplicate claim — that freezes on the same job forever.
  // BUT if questions are already open (script re-entry / SPA), continue answering — do NOT skip.
  if (!claimPage(state.runId, 'detail', state.currentDetailUrl || listingUrl || currentUrl)) {
    const chatOpen = pageHasRecruiterChatbot() || Boolean(getNaukriQuestionModal()) || Boolean(findNaukriChatInput(document));
    const postApply = sessionStorage.getItem(`job-autoapply-post-apply-${state.runId}`) === '1';
    if (chatOpen || postApply) {
      emit({
        status: 'searching',
        jobTitle,
        company,
        reason: 'Resume answering recruiter questions (detail already claimed)...',
      });
      sessionStorage.setItem(`job-autoapply-post-apply-${state.runId}`, '1');
      const outcome = await waitForApplyOutcome(profile, 45000, jobTitle, company);
      if (outcome === 'applied' || detectNaukriApplySuccess() || headerShowsAppliedBadge() || naukriPrimaryApplyLooksApplied()) {
        await finalizeNaukriApplication(state);
        return;
      }
      if (chatOpen || pageHasRecruiterChatbot() || getNaukriQuestionModal()) {
        skipNaukriJobAndAdvance(
          state,
          'Could not finish recruiter questions — skipped (not reopening)',
          listingUrl,
        );
        return;
      }
      // Fall through only if Apply is still available for a fresh click
      releasePageClaim();
      claimPage(state.runId, 'detail', state.currentDetailUrl || listingUrl || currentUrl, true);
    } else if (isNaukriJobHandled(state, listingUrl, jobTitle, company)) {
      releasePageClaim();
      returnToNaukriSearch(state, state.jobIndex + 1);
      return;
    } else {
      // Soft advance without a second skip lead when another handler is mid-flight
      emit({
        status: 'searching',
        jobTitle,
        company,
        reason: 'Another detail handler is active — waiting...',
      });
      await sleep(2500);
      if (pageHasRecruiterChatbot() || getNaukriQuestionModal() || findNaukriChatInput(document)) {
        sessionStorage.setItem(`job-autoapply-post-apply-${state.runId}`, '1');
        const outcome = await waitForApplyOutcome(profile, 40000, jobTitle, company);
        if (outcome === 'applied' || detectNaukriApplySuccess() || headerShowsAppliedBadge()) {
          await finalizeNaukriApplication(state);
          return;
        }
      }
      if (isNaukriJobHandled(state, listingUrl, jobTitle, company)) {
        returnToNaukriSearch(state, state.jobIndex + 1);
        return;
      }
      releasePageClaim();
      claimPage(state.runId, 'detail', state.currentDetailUrl || listingUrl || currentUrl, true);
    }
  }

  if (isNaukriJobHandled(state, currentUrl, jobTitle, company) || isNaukriJobHandled(state, state.currentDetailUrl, jobTitle, company)) {
    skipNaukriJobAndAdvance(state, 'Already handled this job — moving to next', listingUrl);
    return;
  }

  emit({ status: 'searching', jobTitle, company, reason: 'Job page loaded — looking for Apply...' });
  const { external: externalControl, apply: applyBtn } = await waitForExternalOrNormalApply(8000);

  // Company-site Apply (including "Apply to company website") — capture URL like Naukri report
  if (externalControl || (!applyBtn && isExternalApplyJob())) {
    const control = externalControl ?? findExternalApplyControl();
    if (control) {
      await captureNaukriCompanySiteApply(state, jobTitle, company, listingUrl || currentUrl, control);
      return;
    }
  }

  if (detectNaukriSiteError()) {
    skipNaukriJobAndAdvance(state, 'Naukri rate limit', listingUrl);
    return;
  }

  if (isAlreadyAppliedOnPage() || headerShowsAppliedBadge()) {
    // Applied badge = success for this job; toast "already applied to this job" = skip
    if (headerShowsAppliedBadge() || naukriPrimaryApplyLooksApplied()) {
      await finalizeNaukriApplication(state);
      return;
    }
    if (pageShowsOtherApplyInProgress()) {
      emit({
        status: 'searching',
        jobTitle,
        company,
        reason: 'Ignoring other-job apply conflict — continuing on this posting...',
      });
      await dismissNaukriApplyConflictToasts();
      await sleep(1500);
    } else {
      skipNaukriJobAndAdvance(state, 'already applied', listingUrl);
      return;
    }
  }

  if (!applyBtn) {
    // One more pass — CTA can render late on Naukri SPA
    const retry = await waitForExternalOrNormalApply(4000);
    if (retry.external) {
      await captureNaukriCompanySiteApply(state, jobTitle, company, listingUrl || currentUrl, retry.external);
      return;
    }
    if (retry.apply) {
      await proceedWithNormalApply(profile, state, jobTitle, company, currentUrl, retry.apply);
      return;
    }

    markJobProcessed(state, listingUrl);
    state.counts.skipped++;
    recordSkippedLead(jobTitle, company, 'Apply now button not found', listingUrl);
    emit({ status: 'skipped', jobTitle, company, reason: 'Apply now button not found — skipping' });
    returnToNaukriSearch(state, state.jobIndex + 1);
    return;
  }

  await proceedWithNormalApply(profile, state, jobTitle, company, listingUrl, applyBtn);
}

async function proceedWithNormalApply(
  profile: Profile,
  state: NaukriRunState,
  jobTitle: string,
  company: string,
  currentUrl: string,
  applyBtn: HTMLElement,
): Promise<void> {
  emit({ status: 'searching', jobTitle, company, reason: 'Clicking Apply now...' });
  state.currentDetailUrl = currentUrl;
  state.phase = 'detail';
  state.jobTitle = jobTitle;
  state.company = company;
  saveNaukriState(state);

  if (detectNaukriSiteError()) {
    skipNaukriJobAndAdvance(state, 'Naukri rate limit', currentUrl);
    return;
  }

  // Set BEFORE click — Naukri can navigate/unload before the line after click runs
  sessionStorage.setItem(`job-autoapply-post-apply-${state.runId}`, '1');

  const clickResult = await clickNaukriApplyButton(applyBtn);

  if (clickResult === 'site-error') {
    skipNaukriJobAndAdvance(state, 'Naukri rate limit', currentUrl);
    return;
  }

  // Naukri conflict toast after click — wait and answer any open chat, then retry Apply once
  if (pageShowsOtherApplyInProgress()) {
    emit({
      status: 'searching',
      jobTitle,
      company,
      reason: 'Naukri blocked Apply (other job in progress) — waiting and retrying...',
    });
    await dismissNaukriApplyConflictToasts();
    await sleep(2500);
    if (pageHasRecruiterChatbot() || getNaukriQuestionModal()) {
      const lateChat = await waitForApplyOutcome(profile, 25000, jobTitle, company);
      if (lateChat === 'applied') {
        await finalizeNaukriApplication(state);
        return;
      }
    }
    if (isApplyButtonStillOnPage() && !naukriPrimaryApplyLooksApplied()) {
      const retryBtn = findNaukriApplyButtonSync();
      if (retryBtn) {
        emit({ status: 'searching', jobTitle, company, reason: 'Retrying Apply after conflict toast...' });
        await clickNaukriApplyButton(retryBtn);
        await sleep(1000);
      }
    }
  }

  if (clickResult === 'failed'
    && !detectApplyClickWorked()
    && !pageHasRecruiterChatbot()
    && !pageShowsOtherApplyInProgress()
    && isApplyButtonStillOnPage()) {
    skipNaukriJobAndAdvance(state, 'Apply button click did not register — skipping', currentUrl);
    return;
  }

  if (detectNaukriApplySuccess() || headerShowsAppliedBadge()) {
    await finalizeNaukriApplication(state);
    return;
  }

  // Give the recruiter chat time to render — deciding too early is what closed chats mid-question
  emit({ status: 'searching', jobTitle, company, reason: 'Apply clicked — waiting for questions or confirmation...' });
  const waitStart = Date.now();
  while (Date.now() - waitStart < 15000 && !isStopped()) {
    if (pageHasRecruiterChatbot() || getNaukriQuestionModal() || findNaukriChatInput(document)) {
      // Let the first question paint fully before any interaction
      await sleep(1200);
      break;
    }
    if (detectNaukriApplySuccess() || headerShowsAppliedBadge() || naukriPrimaryApplyLooksApplied()) {
      await finalizeNaukriApplication(state);
      return;
    }
    await sleep(600);
  }

  const outcome = await waitForApplyOutcome(profile, 120000, jobTitle, company);

  if (outcome === 'applied') {
    await finalizeNaukriApplication(state);
    return;
  }

  if (outcome === 'already') {
    skipNaukriJobAndAdvance(state, 'already applied to this company', currentUrl);
    return;
  }

  if (
    !naukriRecruiterQuestionsPending()
    && (
      detectNaukriApplySuccess()
      || isNaukriApplyConfirmationPage()
      || headerShowsAppliedBadge()
      || naukriPrimaryApplyLooksApplied()
    )
  ) {
    emit({
      status: 'searching',
      jobTitle,
      company,
      reason: 'Apply confirmed on page — counting as applied',
    });
    await finalizeNaukriApplication(state);
    return;
  }

  // Left job detail for a verified confirmation URL only
  if (!isNaukriJobDetailPage() && !isNaukriSearchPage() && isNaukriApplyConfirmationPage()) {
    emit({
      status: 'searching',
      jobTitle,
      company,
      reason: 'Apply confirmation redirect detected — counting as applied',
    });
    await finalizeNaukriApplication(state);
    return;
  }

  // Click registered (chat opened) but confirmation lagged — keep answering / waiting
  if (pageHasRecruiterChatbot() || getNaukriQuestionModal() || findNaukriChatInput(document) || naukriRecruiterQuestionsPending()) {
    emit({ status: 'searching', jobTitle, company, reason: 'Questions still open — continuing...' });
    const late = await waitForApplyOutcome(profile, 45000, jobTitle, company);
    if (late === 'applied') {
      await finalizeNaukriApplication(state);
      return;
    }
    if (late === 'already') {
      skipNaukriJobAndAdvance(state, 'already applied to this company', currentUrl);
      return;
    }
    // Still on questions → skip once with clear reason (do not return to list and reopen)
    if (pageHasRecruiterChatbot() || getNaukriQuestionModal() || findNaukriChatInput(document) || naukriRecruiterQuestionsPending()) {
      skipNaukriJobAndAdvance(
        state,
        'Could not finish recruiter questions — skipped (not reopening)',
        currentUrl,
      );
      return;
    }
  }

  // Apply button still visible = application never went through
  if (isApplyButtonStillOnPage() && !naukriPrimaryApplyLooksApplied()) {
    skipNaukriJobAndAdvance(state, 'Apply did not complete — button still available', currentUrl);
    return;
  }

  if (detectNaukriSiteError()) {
    skipNaukriJobAndAdvance(state, 'Naukri error after apply', currentUrl);
    return;
  }

  skipNaukriJobAndAdvance(state, 'could not confirm application (no thank-you / success page)', currentUrl);
}

async function runNaukri(profile: Profile, criteria: SearchCriteria): Promise<void> {
  if (isExternalPauseActive()) {
    emit({
      status: 'searching',
      reason: 'Paused — waiting for company website tab to finish before next job',
    });
    return;
  }

  if (isNaukriErrorPage()) {
    const recoverKey = `job-autoapply-404-recover-${currentRunId || 'x'}`;
    const state = loadNaukriState();
    if (state?.currentDetailUrl || state?.phase === 'detail') {
      skipNaukriJobAndAdvance(state, 'Naukri page error / 404 — skipped', state.currentDetailUrl);
      return;
    }
    if (sessionStorage.getItem(recoverKey) === '1') {
      emit({ status: 'failed', reason: 'Naukri 404 persisted after recovery — stopping this run' });
      finish(state?.counts ?? { applied: 0, skipped: 0, failed: 1 });
      return;
    }
    sessionStorage.setItem(recoverKey, '1');
    emit({ status: 'searching', reason: 'Naukri 404 / bad URL — recovering to search…' });
    saveNaukriState(state ?? {
      runId: currentRunId!,
      profile,
      criteria,
      phase: 'list',
      jobIndex: 0,
      counts: { applied: 0, skipped: 0, failed: 0 },
      processedDetailUrls: [],
    });
    window.location.href = buildNaukriSearchUrl(criteria);
    return;
  }

  if (isNaukriJobDetailPage()) {
    const state = loadNaukriState();
    if (!state || state.phase !== 'detail') {
      finish({ applied: 0, skipped: 0, failed: 1 });
      return;
    }
    await applyOnNaukriDetailPage(profile, state);
    return;
  }

  if (!isNaukriSearchPage() || naukriFiltersMissing(criteria)) {
    saveNaukriState(loadNaukriState() ?? {
      runId: currentRunId!,
      profile,
      criteria,
      phase: 'list',
      jobIndex: 0,
      counts: { applied: 0, skipped: 0, failed: 0 },
      processedDetailUrls: [],
    });
    window.location.href = buildNaukriSearchUrl(criteria);
    return;
  }

  const state = loadNaukriState() ?? {
    runId: currentRunId!,
    profile,
    criteria,
    phase: 'list' as const,
    jobIndex: 0,
    counts: { applied: 0, skipped: 0, failed: 0 },
    processedDetailUrls: [] as string[],
  };
  if (!state.processedDetailUrls) state.processedDetailUrls = [];
  if (!state.processedJobKeys) state.processedJobKeys = [];

  // Always allow re-entry to the list after company-site returns / forced resume
  releasePageClaim();
  claimPage(state.runId, 'list', `${window.location.pathname}#${state.jobIndex}`, true);

  sessionStorage.removeItem(`job-autoapply-external-pending-${state.runId}`);
  emit({ status: 'searching', reason: `Waiting for Naukri job listings (index ${state.jobIndex})...` });

  const listWaitMs = isNaukriListLoading() ? 8000 : 12000;
  let cards = await waitForNaukriJobCards(listWaitMs);

  if (isNaukriErrorPage()) {
    const recoverKey = `job-autoapply-404-recover-${state.runId}`;
    if (state.currentDetailUrl || state.phase === 'detail') {
      skipNaukriJobAndAdvance(state, 'Naukri page error / 404 — skipped', state.currentDetailUrl);
      return;
    }
    if (sessionStorage.getItem(recoverKey) === '1') {
      emit({ status: 'failed', reason: 'Naukri 404 persisted after recovery — stopping this run' });
      finish(state.counts);
      return;
    }
    sessionStorage.setItem(recoverKey, '1');
    emit({ status: 'searching', reason: 'Naukri 404 / bad URL — recovering to search…' });
    releasePageClaim();
    sessionStorage.removeItem(EXEC_KEY);
    window.location.href = buildNaukriSearchUrl(criteria);
    return;
  }

  // Naukri SPA sometimes sticks on the loader after tab restore — recover once, then stop looping
  const pageUrlKey = normalizeJobUrl(window.location.href);
  const reloadKey = `job-autoapply-list-reload-${state.runId}-${pageUrlKey}`;
  if (cards.length === 0 && !isStopped() && sessionStorage.getItem(reloadKey) !== '1') {
    sessionStorage.setItem(reloadKey, '1');
    emit({ status: 'searching', reason: 'Job list still loading — refreshing Naukri search...' });
    releasePageClaim();
    sessionStorage.removeItem(EXEC_KEY);
    const target = buildNaukriSearchUrl(state.criteria);
    if (pageUrlKey === normalizeJobUrl(target)) {
      window.location.reload();
    } else {
      window.location.href = target;
    }
    return;
  }

  if (cards.length === 0) {
    if (!hasReachedApplyCap(state) && tryWidenNaukriJobAge(state)) {
      return;
    }

    if (!hasReachedApplyCap(state) && goToNextNaukriResultsPage(state)) {
      emit({ status: 'searching', reason: 'No cards on this page — trying next Naukri results page...' });
      return;
    }

    emit({
      status: 'searching',
      reason: hasReachedApplyCap(state)
        ? `Target reached (${state.counts.applied}/${state.criteria.dailyApplicationCap} applied)`
        : `No more Naukri jobs left after widening job age (${state.counts.applied}/${state.criteria.dailyApplicationCap} applied). Stopping.`,
    });
    finish(state.counts);
    return;
  }

  emit({ status: 'searching', reason: `Found ${cards.length} jobs — opening postings one by one...` });

  // Company-site tab still open — one job at a time, so wait for the user to close it
  if (isExternalPauseActive(state.runId)) {
    emit({
      status: 'searching',
      reason: 'Paused — waiting for company website tab to finish before next job',
    });
    return;
  }

  // Always scan the full visible list for the next UNHANDLED job (index cursor alone caused reopen loops)
  let opened = false;
  for (let i = 0; i < cards.length && !isStopped(); i++) {
    if (hasReachedApplyCap(state)) break;

    const card = cards[i];
    const { title: jobTitle, company } = getJobMeta(card);
    const detailUrl = getJobDetailUrl(card);
    const normalizedDetailUrl = detailUrl ? normalizeJobUrl(detailUrl) : '';

    if (card.textContent?.includes('Applied')) {
      state.jobTitle = jobTitle;
      state.company = company;
      if (normalizedDetailUrl) markJobProcessed(state, normalizedDetailUrl);
      const key = naukriJobKey(jobTitle, company);
      if (!state.processedJobKeys) state.processedJobKeys = [];
      if (key !== '|' && !state.processedJobKeys.includes(key)) state.processedJobKeys.push(key);
      state.counts.skipped++;
      recordSkippedLead(jobTitle, company, 'already applied (listing badge)', normalizeJobUrl(window.location.href));
      emit({ status: 'skipped', jobTitle, company, reason: 'already applied' });
      state.jobIndex = i + 1;
      saveNaukriState(state);
      continue;
    }

    if (!detailUrl || !normalizedDetailUrl) {
      state.counts.skipped++;
      if (!state.processedJobKeys) state.processedJobKeys = [];
      const key = naukriJobKey(jobTitle, company);
      if (key !== '|' && !state.processedJobKeys.includes(key)) state.processedJobKeys.push(key);
      recordSkippedLead(jobTitle, company, 'Job posting link not found', normalizeJobUrl(window.location.href));
      emit({ status: 'skipped', jobTitle, company, reason: 'Job posting link not found' });
      state.jobIndex = i + 1;
      saveNaukriState(state);
      continue;
    }

    if (isNaukriJobHandled(state, normalizedDetailUrl, jobTitle, company)) {
      state.jobIndex = i + 1;
      saveNaukriState(state);
      continue;
    }

    const openCount = Number(sessionStorage.getItem(`job-autoapply-open-count-${normalizedDetailUrl}`) || '0');
    const skipAlreadyRecorded = sessionStorage.getItem(`job-autoapply-skip-recorded-${normalizedDetailUrl}`) === '1';
    // Cap reopen attempts — silent if already skipped/processed (no duplicate report row)
    if (openCount >= NAUKRI_MAX_JOB_OPENS || skipAlreadyRecorded) {
      if (!isNaukriJobHandled(state, normalizedDetailUrl, jobTitle, company)) {
        markJobProcessed(state, normalizedDetailUrl);
        if (!skipAlreadyRecorded) {
          state.counts.skipped++;
          const attemptReason = `Job page never became applyable after ${openCount} opens — skipped`;
          recordSkippedLead(jobTitle, company, attemptReason, normalizedDetailUrl);
          sessionStorage.setItem(`job-autoapply-skip-recorded-${normalizedDetailUrl}`, '1');
          emit({
            status: 'skipped',
            jobTitle,
            company,
            reason: attemptReason,
          });
        }
      }
      state.jobIndex = i + 1;
      saveNaukriState(state);
      continue;
    }

    state.jobIndex = i;
    state.jobTitle = jobTitle;
    state.company = company;
    state.phase = 'detail';
    state.currentDetailUrl = normalizedDetailUrl;
    saveNaukriState(state);
    releasePageClaim();
    sessionStorage.removeItem(EXEC_KEY);
    sessionStorage.removeItem(`job-autoapply-post-apply-${state.runId}`);

    emit({ status: 'searching', jobTitle, company, reason: 'Opening job posting...' });
    // One job at a time, with a breather so Naukri is not hit back-to-back
    await randomDelay(1200, 2000);
    if (isStopped()) return;
    // Counted only once the navigation is actually issued — a pass aborted by a forced resume
    // during the pause used to burn the budget without ever opening the job.
    noteNaukriDetailAttempt(normalizedDetailUrl);
    noteNaukriNavIntent(normalizedDetailUrl);
    window.location.href = detailUrl;
    opened = true;
    break;
  }

  if (opened) return;

  if (isStopped()) {
    emit({ status: 'interrupted', reason: 'Stopped by user' });
    finish(state.counts);
    return;
  }

  if (hasReachedApplyCap(state)) {
    emit({
      status: 'searching',
      reason: `Target reached (${state.counts.applied}/${state.criteria.dailyApplicationCap} applied)`,
    });
    finish(state.counts);
    return;
  }

  if (goToNextNaukriResultsPage(state)) {
    emit({ status: 'searching', reason: 'Moving to next Naukri results page...' });
    return;
  }

  // Still under target with no next page — widen jobAge 1 → 3 → 7, then stop
  if (tryWidenNaukriJobAge(state)) {
    return;
  }

  emit({
    status: 'searching',
    reason: `No more Naukri jobs left (${state.counts.applied}/${state.criteria.dailyApplicationCap} applied). Job age already at 7 days — stopping.`,
  });
  finish(state.counts);
}

async function fillInput(input: HTMLInputElement, value: string): Promise<void> {
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function getLinkedInCardJobId(card?: HTMLElement | null): string {
  if (!card) return '';
  const attr = card.getAttribute('data-job-id')
    || card.getAttribute('data-occludable-job-id')
    || card.querySelector('[data-job-id]')?.getAttribute('data-job-id')
    || card.querySelector('[data-occludable-job-id]')?.getAttribute('data-occludable-job-id')
    || '';
  if (attr && /^\d+$/.test(attr)) return attr;

  const urn = card.getAttribute('data-entity-urn')
    || card.querySelector('[data-entity-urn]')?.getAttribute('data-entity-urn')
    || '';
  const urnMatch = urn.match(/jobPosting:(\d+)/);
  if (urnMatch?.[1]) return urnMatch[1];

  const link = card.querySelector<HTMLAnchorElement>(
    'a[href*="/jobs/view/"], a[href*="currentJobId="], a.job-card-container__link, a.job-card-list__title--link',
  );
  if (link?.href) {
    try {
      const u = new URL(link.href, window.location.origin);
      const fromPath = u.pathname.match(/\/jobs\/view\/(\d+)/);
      if (fromPath?.[1]) return fromPath[1];
      const fromQuery = u.searchParams.get('currentJobId');
      if (fromQuery && /^\d+$/.test(fromQuery)) return fromQuery;
    } catch {
      // ignore
    }
  }
  return '';
}

function linkedInJobKey(card: HTMLElement, jobTitle: string, company: string): string {
  const id = getLinkedInCardJobId(card);
  return id || `${normalizeText(jobTitle)}|${normalizeText(company)}`;
}

/** Stable per-job LinkedIn URL — never use the shared search URL (wrong job when reopened). */
function getLinkedInJobListingUrl(card?: HTMLElement | null): string {
  const fromCard = getLinkedInCardJobId(card);
  if (fromCard) return `https://www.linkedin.com/jobs/view/${fromCard}`;

  try {
    const cur = new URLSearchParams(window.location.search).get('currentJobId');
    if (cur) return `https://www.linkedin.com/jobs/view/${cur}`;
  } catch {
    // ignore
  }

  return window.location.href.split('#')[0];
}

function cleanLinkedInMetaText(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim();
}

function isUsableLinkedInMeta(value: string | undefined | null): boolean {
  const v = cleanLinkedInMetaText(value);
  if (!v) return false;
  const lower = v.toLowerCase();
  return lower !== 'unknown' && lower !== 'company name' && lower !== 'linkedin';
}

/** Prefer real company/title text; never let "Unknown" overwrite a good value. */
function mergeLinkedInJobMeta(
  base: { jobTitle: string; company: string },
  next: { jobTitle?: string; company?: string } | null | undefined,
): { jobTitle: string; company: string } {
  if (!next) return base;
  return {
    jobTitle: isUsableLinkedInMeta(next.jobTitle) ? cleanLinkedInMetaText(next.jobTitle) : base.jobTitle,
    company: isUsableLinkedInMeta(next.company) ? cleanLinkedInMetaText(next.company) : base.company,
  };
}

function parseLinkedInCardTextLines(card: HTMLElement): { jobTitle: string; company: string } {
  const lines = (card.innerText || '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((l) => {
      const lower = l.toLowerCase();
      if (lower === 'promoted' || lower === 'applied' || lower === 'easy apply') return false;
      if (/^\d+(\+)?\s*(connection|applicant|hour|day|week|month|minute)/i.test(l)) return false;
      if (/^(remote|hybrid|on-site|onsite)\b/i.test(l)) return false;
      if (l.length < 2 || l.length > 140) return false;
      return true;
    });

  // Typical card: title, company, location…
  const jobTitle = lines[0] || 'Unknown';
  let company = 'Unknown';
  for (let i = 1; i < Math.min(lines.length, 5); i++) {
    const line = lines[i];
    // Skip location-like lines (City, Country / · separators with geo)
    if (/,\s*[A-Z][a-z]+/.test(line) && !/[A-Za-z]{3,}\s+(Inc|Ltd|LLC|Pvt|Technologies|Systems|Labs)/i.test(line)) {
      continue;
    }
    if (/^\d/.test(line)) continue;
    company = line;
    break;
  }
  return { jobTitle, company };
}

function getLinkedInDetailJobMeta(): { jobTitle: string; company: string } | null {
  const root = document.querySelector<HTMLElement>(
    '.jobs-unified-top-card, .job-details-jobs-unified-top-card, .jobs-details__main-content, .scaffold-layout__detail',
  );
  if (!root) return null;

  const titleEl = root.querySelector<HTMLElement>(
    'h1, .job-details-jobs-unified-top-card__job-title, .job-details-jobs-unified-top-card__job-title a, .t-24, .jobs-unified-top-card__job-title',
  );
  const jobTitle = cleanLinkedInMetaText(titleEl?.textContent);

  const companySelectors = [
    '.job-details-jobs-unified-top-card__company-name a',
    '.job-details-jobs-unified-top-card__company-name',
    '.jobs-unified-top-card__company-name a',
    '.jobs-unified-top-card__company-name',
    '.job-details-jobs-unified-top-card__primary-description-container a[href*="/company/"]',
    'a.job-details-jobs-unified-top-card__company-name',
    'a[data-tracking-control-name*="company" i]',
    'a[href*="/company/"]',
  ];
  let company = '';
  for (const sel of companySelectors) {
    try {
      const el = root.querySelector<HTMLElement>(sel);
      const text = cleanLinkedInMetaText(el?.textContent);
      if (isUsableLinkedInMeta(text) && text.length < 120) {
        company = text;
        break;
      }
    } catch {
      // ignore invalid selector
    }
  }

  if (!jobTitle && !company) return null;
  return {
    jobTitle: jobTitle || 'Unknown',
    company: company || 'Unknown',
  };
}

function findLinkedInNextPageButton(): HTMLElement | null {
  const selectors = [
    'button[aria-label="Page next"]',
    'button[aria-label*="Next" i]',
    'button.jobs-search-pagination__button--next',
    '.jobs-search-pagination button[aria-label*="next" i]',
  ];
  for (const sel of selectors) {
    try {
      const el = document.querySelector<HTMLElement>(sel);
      if (el && isVisible(el) && !(el as HTMLButtonElement).disabled) return el;
    } catch {
      // ignore invalid selector
    }
  }
  for (const el of document.querySelectorAll<HTMLElement>('button, a')) {
    if (!isVisible(el)) continue;
    if ((el as HTMLButtonElement).disabled) continue;
    const label = normalizeText(el.getAttribute('aria-label') ?? el.textContent ?? '');
    if (label === 'next' || label.startsWith('next ') || label === 'page next') return el;
  }
  return null;
}

async function collectLinkedInJobCards(): Promise<HTMLElement[]> {
  const list = document.querySelector<HTMLElement>(
    '.jobs-search-results-list, .scaffold-layout__list, div.jobs-search-results-list',
  );
  if (list) {
    for (let s = 0; s < 4; s++) {
      list.scrollTop = list.scrollHeight;
      await sleep(400);
    }
    list.scrollTop = 0;
  }

  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '.job-card-container, li.jobs-search-results__list-item, .jobs-search-results__list-item',
    ),
  ).filter((card) => {
    const rect = card.getBoundingClientRect();
    return rect.height > 0 || isVisible(card);
  });
}

async function goToLinkedInNextPage(state: LinkedInRunState): Promise<boolean> {
  const next = findLinkedInNextPageButton();
  if (!next) return false;

  const firstCard = (): HTMLElement | null => document.querySelector<HTMLElement>(
    '.job-card-container, li.jobs-search-results__list-item, .jobs-search-results__list-item',
  );
  const beforeId = getLinkedInCardJobId(firstCard())
    || firstCard()?.querySelector('.job-card-list__title, a.job-card-list__title--link')?.textContent?.trim()
    || '';

  emit({ status: 'searching', reason: 'Moving to next LinkedIn results page...' });
  state.jobIndex = 0;
  saveLinkedInState(state);
  releasePageClaim();
  forceClick(next);

  // Stay in this runLinkedIn call — resumePendingRun is blocked while automationActive
  // and was the reason the bot stalled after pagination.
  for (let attempt = 0; attempt < 24 && !isStopped(); attempt++) {
    await sleep(500);
    const card = firstCard();
    if (!card) continue;
    const afterId = getLinkedInCardJobId(card)
      || card.querySelector('.job-card-list__title, a.job-card-list__title--link')?.textContent?.trim()
      || '';
    if (!beforeId || afterId !== beforeId || attempt >= 8) {
      const count = document.querySelectorAll(
        '.job-card-container, li.jobs-search-results__list-item',
      ).length;
      emit({
        status: 'searching',
        reason: `Next page loaded (${count} jobs) — continuing...`,
      });
      return true;
    }
  }

  emit({ status: 'searching', reason: 'Next page click did not load new jobs' });
  return false;
}

async function widenLinkedInDateFilter(state: LinkedInRunState): Promise<boolean> {
  const current = state.criteria.datePosted;
  let next: SearchCriteria['datePosted'] | null = null;
  if (current === 'Past 24h') next = 'Past week';
  else if (current === 'Past week') next = 'Any time';
  if (!next) return false;

  emit({
    status: 'searching',
    reason: `No more jobs for ${current} — widening to ${next} to reach daily cap...`,
  });
  state.criteria = { ...state.criteria, datePosted: next };
  state.jobIndex = 0;
  saveLinkedInState(state);
  releasePageClaim();
  sessionStorage.removeItem(EXEC_KEY);
  window.location.href = buildLinkedInSearchUrl(state.criteria);
  return true;
}

function getLinkedInJobMeta(card: HTMLElement): { jobTitle: string; company: string } {
  const titleEl = card.querySelector<HTMLElement>(
    '.job-card-list__title--link, a.job-card-list__title--link, .job-card-list__title, .artdeco-entity-lockup__title a, .artdeco-entity-lockup__title, a.job-card-container__link, strong.job-card-list__title, a[data-control-id]',
  );
  let jobTitle = cleanLinkedInMetaText(titleEl?.textContent);

  const companySelectors = [
    '.job-card-container__company-name',
    '.artdeco-entity-lockup__subtitle span',
    '.artdeco-entity-lockup__subtitle',
    'h4.base-search-card__subtitle',
    '.base-search-card__subtitle',
    'a[data-control-name="job_card_company_link"]',
    'a[href*="/company/"]',
  ];
  let company = '';
  for (const sel of companySelectors) {
    const el = card.querySelector<HTMLElement>(sel);
    const text = cleanLinkedInMetaText(el?.textContent);
    // primary-description is often location on newer LinkedIn — skip if it looks like geo
    if (!isUsableLinkedInMeta(text)) continue;
    if (sel.includes('primary-description') && /,/.test(text)) continue;
    company = text;
    break;
  }

  // Fallback: parse visible card text (LinkedIn often obfuscates class names)
  if (!isUsableLinkedInMeta(jobTitle) || !isUsableLinkedInMeta(company)) {
    const parsed = parseLinkedInCardTextLines(card);
    if (!isUsableLinkedInMeta(jobTitle) && isUsableLinkedInMeta(parsed.jobTitle)) {
      jobTitle = parsed.jobTitle;
    }
    if (!isUsableLinkedInMeta(company) && isUsableLinkedInMeta(parsed.company)) {
      company = parsed.company;
    }
  }

  return {
    jobTitle: isUsableLinkedInMeta(jobTitle) ? jobTitle : 'Unknown',
    company: isUsableLinkedInMeta(company) ? company : 'Unknown',
  };
}

function hasLinkedInExternalIcon(el: HTMLElement): boolean {
  if (el.querySelector(
    'li-icon[type="link-external"], [data-test-icon*="link-external"], svg[data-test-icon*="link-external"]',
  )) {
    return true;
  }
  const html = el.innerHTML.toLowerCase();
  return html.includes('link-external')
    || html.includes('external-link')
    || html.includes('link_external')
    || html.includes('arrow-up-right');
}

function isLinkedInEasyApplyControl(el: HTMLElement): boolean {
  const text = getElementText(el);
  const aria = (el.getAttribute('aria-label') ?? '').toLowerCase();
  if (text.includes('easy apply') || aria.includes('easy apply')) return true;
  // LinkedIn often nests "Easy Apply" text in a child/sibling of the button wrapper
  const wrap = el.closest(
    '.jobs-s-apply, .jobs-apply-button, .jobs-apply-button--top-card, .jobs-unified-top-card__content--two-pane',
  );
  if (wrap) {
    const wrapText = normalizeText(wrap.textContent ?? '');
    if (wrapText.includes('easy apply')) return true;
  }
  return false;
}

function isLinkedInOffsiteApplyControl(el: HTMLElement): boolean {
  if (isLinkedInEasyApplyControl(el)) return false;
  const text = getElementText(el);
  const aria = (el.getAttribute('aria-label') ?? '').toLowerCase();

  if (isExternalApplyLabel(text) || aria.includes('company website') || aria.includes('on company website')) {
    return true;
  }

  const looksLikeApply = text === 'apply'
    || text.startsWith('apply ')
    || aria === 'apply'
    || (aria.includes('apply') && !aria.includes('easy'));

  if (!looksLikeApply) return false;

  // Plain "Apply" with external-link icon → company website
  if (hasLinkedInExternalIcon(el)) return true;
  // Parent wrapper often holds the external icon
  const wrap = el.closest('.jobs-s-apply, .jobs-apply-button, .jobs-apply-button--top-card') as HTMLElement | null;
  if (wrap && hasLinkedInExternalIcon(wrap)) return true;

  // jobs-apply-button that is not Easy Apply is offsite Apply
  const cls = (el.className?.toString() ?? '').toLowerCase();
  if (cls.includes('jobs-apply-button') && !cls.includes('easy')) return true;
  if (wrap) {
    const wrapCls = (wrap.className?.toString() ?? '').toLowerCase();
    if (wrapCls.includes('jobs-apply-button') && !wrapCls.includes('easy')) return true;
  }

  // Anchor leaving LinkedIn
  if (el.tagName === 'A') {
    const href = (el as HTMLAnchorElement).href || '';
    if (href && !href.includes('linkedin.com')) return true;
    if (href.includes('/safety/go') || href.includes('redirect')) return true;
  }

  // Top-card "Apply" that is NOT Easy Apply → treat as company-site (LinkedIn often omits icon in DOM)
  const inTopCard = Boolean(el.closest(
    '.jobs-unified-top-card, .job-details-jobs-unified-top-card, .jobs-s-apply, .jobs-apply-button--top-card',
  ));
  if (inTopCard && (text === 'apply' || text.startsWith('apply '))) return true;

  return false;
}

function getLinkedInApplyScope(): ParentNode {
  return document.querySelector(
    '.jobs-unified-top-card, .job-details-jobs-unified-top-card, .jobs-details__main-content, .jobs-details, .scaffold-layout__detail, .job-view-layout',
  ) ?? document;
}

/** LinkedIn offsite Apply is often just "Apply" + external icon — not "company website". */
function findLinkedInApplyControls(): { external: HTMLElement | null; easyApply: HTMLElement | null } {
  const scope = getLinkedInApplyScope();
  let external: HTMLElement | null = null;
  let easyApply: HTMLElement | null = null;

  const consider = (el: HTMLElement) => {
    if (!isVisible(el)) return;
    const control = (el.closest('button, a') as HTMLElement | null) ?? el;
    if (!isVisible(control)) return;
    const text = getElementText(control);
    const aria = (control.getAttribute('aria-label') ?? '').toLowerCase();
    if (!text.includes('apply') && !aria.includes('apply')) return;

    if (isLinkedInEasyApplyControl(control)) {
      if (!easyApply) easyApply = control;
      return;
    }
    if (isLinkedInOffsiteApplyControl(control)) {
      if (!external) external = control;
    }
  };

  // 1) Primary LinkedIn apply CTAs
  scope.querySelectorAll<HTMLElement>(
    'button.jobs-apply-button, a.jobs-apply-button, .jobs-apply-button--top-card button, .jobs-s-apply button',
  ).forEach(consider);

  // 2) Aria-labelled Apply controls in the top card only
  if (!external && !easyApply) {
    scope.querySelectorAll<HTMLElement>('button[aria-label*="Apply" i], a[aria-label*="Apply" i]').forEach(consider);
  }

  // 3) Last resort: visible "Apply" text in top card (never treat as skip)
  if (!external && !easyApply) {
    for (const el of scope.querySelectorAll<HTMLElement>('button, a[href]')) {
      if (!isVisible(el)) continue;
      const text = normalizeText(el.textContent ?? '');
      if (text !== 'apply' && !/^apply\b/.test(text)) continue;
      // Ignore tiny footer / share widgets
      const rect = el.getBoundingClientRect();
      if (rect.top > window.innerHeight * 0.7) continue;
      consider(el);
      if (external || easyApply) break;
    }
  }

  return { external, easyApply };
}

function findLinkedInExternalApplyControl(): HTMLElement | null {
  return findLinkedInApplyControls().external;
}

function findLinkedInEasyApplyButton(): HTMLButtonElement | null {
  const btn = findLinkedInApplyControls().easyApply;
  return (btn as HTMLButtonElement | null) ?? null;
}

function getLinkedInEasyApplyModal(): HTMLElement | null {
  const modal = document.querySelector(
    '.jobs-easy-apply-modal, div[data-test-modal-id="easy-apply-modal"], .jobs-easy-apply-content',
  ) as HTMLElement | null;
  if (modal && isVisible(modal)) return modal;
  for (const dialog of document.querySelectorAll<HTMLElement>('[role="dialog"]')) {
    if (!isVisible(dialog)) continue;
    const text = (dialog.textContent ?? '').toLowerCase();
    if (text.includes('easy apply') || text.includes('contact info') || dialog.querySelector('.jobs-easy-apply-content')) {
      return dialog;
    }
  }
  return null;
}

/** LinkedIn asks this when Easy Apply is closed before Submit. */
function dismissLinkedInSaveApplicationPrompt(): boolean {
  for (const dialog of document.querySelectorAll<HTMLElement>('[role="dialog"], .artdeco-modal')) {
    if (!isVisible(dialog)) continue;
    const text = (dialog.textContent ?? '').toLowerCase();
    if (!(
      text.includes('save this application')
      || text.includes('save to return to this application')
      || (text.includes('discard') && text.includes('save') && text.includes('application'))
    )) {
      continue;
    }
    for (const btn of dialog.querySelectorAll<HTMLElement>('button')) {
      if (!isVisible(btn)) continue;
      const label = normalizeText(btn.textContent ?? '');
      // Discard unfinished drafts so we can continue the run
      if (label === 'discard') {
        forceClick(btn);
        return true;
      }
    }
  }
  return false;
}

/** Close success / promo overlays only — never the Easy Apply form itself. */
function dismissLinkedInModals(): void {
  // Unfinished-apply save prompt (from a prior close)
  if (dismissLinkedInSaveApplicationPrompt()) return;

  // Post-apply promo: "Your application was sent…" with Not now / Update profile
  for (const dialog of document.querySelectorAll<HTMLElement>('[role="dialog"], .artdeco-modal')) {
    if (!isVisible(dialog)) continue;
    const text = (dialog.textContent ?? '').toLowerCase();
    if (!(
      text.includes('application was sent')
      || text.includes('application sent')
      || text.includes('keep track of your application')
      || text.includes('update profile')
      || text.includes('turn your resume into a profile')
    )) {
      continue;
    }
    // Never treat the main Easy Apply form as a success dialog
    if (text.includes('additional questions') || text.includes('contact info') || text.includes('review your application')) {
      continue;
    }
    for (const btn of dialog.querySelectorAll<HTMLElement>('button')) {
      if (!isVisible(btn)) continue;
      const label = normalizeText(btn.textContent ?? btn.getAttribute('aria-label') ?? '');
      if (
        label === 'not now'
        || label === 'dismiss'
        || label === 'close'
        || label === 'done'
        || label === 'great'
        || label === 'ok'
        || label === 'no thanks'
      ) {
        forceClick(btn);
        return;
      }
    }
    const x = dialog.querySelector<HTMLElement>(
      'button[aria-label="Dismiss"], button[aria-label="Close"], button.artdeco-modal__dismiss, button[data-test-modal-close-btn]',
    );
    if (x && isVisible(x)) {
      forceClick(x);
      return;
    }
  }
}

/** Close Easy Apply mid-flow, then Discard the "Save this application?" prompt. */
async function abandonLinkedInEasyApply(): Promise<void> {
  const modal = getLinkedInEasyApplyModal();
  if (modal) {
    const x = modal.querySelector<HTMLElement>(
      'button[aria-label="Dismiss"], button[aria-label="Close"], button.artdeco-modal__dismiss, button[data-test-modal-close-btn]',
    );
    if (x && isVisible(x)) forceClick(x);
  }
  await sleep(300);
  for (let i = 0; i < 5; i++) {
    if (!dismissLinkedInSaveApplicationPrompt()) break;
    await sleep(200);
  }
  dismissLinkedInModals();
}

/** Immediately close the post-submit success / “Update profile” promo. */
async function dismissLinkedInPostApplyOverlay(): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    dismissLinkedInSaveApplicationPrompt();
    const hasSuccess = detectLinkedInApplySuccess();
    if (!hasSuccess) {
      // Also clear a leftover save prompt without touching Easy Apply
      if (!dismissLinkedInSaveApplicationPrompt()) return;
    }
    dismissLinkedInModals();
    for (const btn of document.querySelectorAll<HTMLElement>('button')) {
      if (!isVisible(btn)) continue;
      const label = normalizeText(btn.textContent ?? '');
      if (label === 'not now' || label === 'done' || label === 'great' || label === 'discard') {
        forceClick(btn);
        break;
      }
    }
    await sleep(150);
    const stillOpen = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).some((d) => {
      if (!isVisible(d)) return false;
      const t = (d.textContent ?? '').toLowerCase();
      return t.includes('application was sent')
        || t.includes('update profile')
        || t.includes('save this application')
        || t.includes('save to return');
    });
    if (!stillOpen) return;
  }
}

function linkedInTopCardShowsApplied(): boolean {
  const scope = document.querySelector(
    '.jobs-unified-top-card, .job-details-jobs-unified-top-card, .jobs-details__main-content, .jobs-details, .scaffold-layout__detail',
  ) as HTMLElement | null;
  if (!scope) return false;

  // Only inspect the open job detail pane — never the left results list
  for (const btn of scope.querySelectorAll<HTMLElement>('button.jobs-apply-button, button, a')) {
    if (!isVisible(btn)) continue;
    const label = getElementText(btn);
    if (label === 'applied' || label.startsWith('applied ')) return true;
    if (label.includes('applied') && !label.includes('easy apply') && !label.includes('company')) return true;
  }
  return false;
}

/** Success UI for the job we just submitted (optional company match). */
function detectLinkedInApplySuccess(expectedCompany?: string): boolean {
  const successPhrases = [
    'application sent',
    'your application was sent',
    'application submitted',
    'successfully submitted',
    'you applied',
    "you're applied",
    'applied to this job',
    'thank you for applying',
    'application was submitted',
    'your application was successfully submitted',
  ];

  if (document.querySelector('[data-test-modal-id="easy-apply-success"], .post-apply-modal')) {
    if (!expectedCompany) return true;
    const modal = document.querySelector(
      '[data-test-modal-id="easy-apply-success"], .post-apply-modal, [role="dialog"]',
    );
    const text = (modal?.textContent ?? '').toLowerCase();
    return text.includes(expectedCompany.toLowerCase().slice(0, 12));
  }

  const scopes: HTMLElement[] = [];
  document.querySelectorAll<HTMLElement>(
    '.artdeco-toast-item, .artdeco-inline-feedback--success, [role="alert"], [role="dialog"], .post-apply-modal',
  ).forEach((el) => {
    if (isVisible(el)) scopes.push(el);
  });

  for (const scope of scopes) {
    const text = (scope.textContent ?? '').toLowerCase();
    if (!successPhrases.some((p) => text.includes(p))) continue;
    if (expectedCompany) {
      const needle = expectedCompany.toLowerCase().replace(/\s+/g, ' ').trim();
      if (needle.length >= 3 && !text.includes(needle.slice(0, Math.min(needle.length, 18)))) {
        continue;
      }
    }
    return true;
  }

  return false;
}

function detectLinkedInApplyError(): boolean {
  const text = (document.body?.innerText ?? '').toLowerCase();
  return text.includes('something went wrong')
    || text.includes("can't submit application")
    || text.includes('cannot submit application')
    || text.includes('please fix the following errors');
}

async function waitForLinkedInApplySuccess(
  timeoutMs = 8000,
  expectedCompany?: string,
): Promise<boolean> {
  const start = Date.now();
  // Ignore a leftover success dialog from a previous job
  const successAlreadyOpen = detectLinkedInApplySuccess();
  if (successAlreadyOpen) {
    await dismissLinkedInPostApplyOverlay();
    await sleep(200);
  }

  while (Date.now() - start < timeoutMs && !isStopped()) {
    if (detectLinkedInApplySuccess(expectedCompany)) {
      await dismissLinkedInPostApplyOverlay();
      return true;
    }
    if (detectLinkedInApplyError()) return false;
    if (linkedInTopCardShowsApplied()) {
      await dismissLinkedInPostApplyOverlay();
      return true;
    }
    await sleep(200);
  }
  if (detectLinkedInApplySuccess(expectedCompany) || linkedInTopCardShowsApplied()) {
    await dismissLinkedInPostApplyOverlay();
    return true;
  }
  return false;
}

function findLinkedInModalActionButton(labels: string[]): HTMLButtonElement | null {
  const modal = getLinkedInEasyApplyModal() ?? document;
  const buttons = modal.querySelectorAll<HTMLButtonElement>('button');
  for (const btn of buttons) {
    if (!isVisible(btn) || btn.disabled) continue;
    const aria = normalizeText(btn.getAttribute('aria-label') ?? '');
    const text = normalizeText(btn.textContent ?? '');
    for (const label of labels) {
      const needle = normalizeText(label);
      if (aria === needle || text === needle || aria.includes(needle) || text.includes(needle)) {
        return btn;
      }
    }
  }
  return null;
}

const LINKEDIN_GROUP_SELECTOR = [
  '.fb-dash-form-element',
  '.jobs-easy-apply-form-element',
  '.fb-form-element',
  '.jobs-easy-apply-form-section__grouping',
  'fieldset',
].join(', ');

function getLinkedInFieldGroup(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>(LINKEDIN_GROUP_SELECTOR);
}

function getLinkedInFieldLabel(el: HTMLElement): string {
  const pickClean = (raw: string): string => {
    let text = normalizeText(raw);
    if (!text) return '';
    // LinkedIn often appends Yes/No option text into the label node
    text = text
      .replace(/\bRequired\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // Prefer the question portion before option lists
    const beforeOptions = text.split(/\b(?:Yes|No|Select an option)\b/i)[0]?.trim();
    if (beforeOptions && beforeOptions.length >= 3) text = beforeOptions;
    // Cap length — mega-labels cause every field to match "experience" / "years"
    if (text.length > 220) {
      const withQ = text.match(/^(.{8,220}\?)/);
      text = withQ ? withQ[1] : text.slice(0, 220);
    }
    return text;
  };

  const isOptionOnly = (text: string) => {
    const t = normalizeText(text);
    return !t || t === 'yes' || t === 'no' || t === 'true' || t === 'false';
  };

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts: string[] = [];
    for (const id of labelledBy.split(/\s+/)) {
      const node = document.getElementById(id);
      if (!node) continue;
      // Skip helper/error nodes referenced in labelledby
      const cls = (node.className?.toString() ?? '').toLowerCase();
      if (cls.includes('error') || cls.includes('helper') || cls.includes('feedback')) continue;
      parts.push(node.textContent ?? '');
    }
    const fromIds = pickClean(parts.join(' '));
    if (fromIds.length >= 3 && !isOptionOnly(fromIds)) return fromIds;
  }

  const aria = pickClean(el.getAttribute('aria-label') ?? '');
  if (aria.length >= 3 && !isOptionOnly(aria)) return aria;

  if (el.id) {
    try {
      const forLabel = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const fromFor = pickClean(forLabel?.textContent ?? '');
      if (fromFor.length >= 3 && !isOptionOnly(fromFor)) return fromFor;
    } catch {
      // invalid id
    }
  }

  // Fieldset legend is the real question for Yes/No radio groups
  const fieldset = el.closest('fieldset');
  if (fieldset) {
    const legend = pickClean(fieldset.querySelector('legend')?.textContent ?? '');
    if (legend.length >= 3 && !isOptionOnly(legend)) return legend;
  }

  const group = getLinkedInFieldGroup(el);
  if (group) {
    const labelEl = group.querySelector(
      'legend, .fb-dash-form-element__label, .jobs-easy-apply-form-element__label, label .t-14, span[aria-hidden="true"], label',
    );
    // Prefer dedicated question nodes — not the radio option label ("Yes"/"No")
    const candidates = [
      group.querySelector('legend')?.textContent,
      group.querySelector('.fb-dash-form-element__label')?.textContent,
      group.querySelector('.jobs-easy-apply-form-element__label')?.textContent,
      labelEl?.textContent,
    ];
    for (const raw of candidates) {
      const fromGroupLabel = pickClean(raw ?? '');
      if (fromGroupLabel.length >= 3 && !isOptionOnly(fromGroupLabel)) return fromGroupLabel;
    }
  }

  const ownLabel = pickClean(el.closest('label')?.textContent ?? '');
  if (ownLabel.length >= 3 && !isOptionOnly(ownLabel) && ownLabel.length < 220) return ownLabel;

  return pickClean(el.getAttribute('placeholder') ?? '');
}

function getLinkedInFieldError(el: HTMLElement): string {
  const scope = getLinkedInFieldGroup(el) ?? el.parentElement;
  if (!scope) return '';
  const errors = scope.querySelectorAll(
    '.artdeco-inline-feedback--error, .fb-dash-form-element__error-field, .artdeco-text-input--error, [role="alert"]',
  );
  return normalizeText(Array.from(errors).map((e) => e.textContent ?? '').join(' '));
}

function linkedInModalHasFieldErrors(): boolean {
  const modal = getLinkedInEasyApplyModal();
  if (!modal) return false;
  for (const el of modal.querySelectorAll<HTMLElement>('.artdeco-inline-feedback--error, [role="alert"]')) {
    if (!isVisible(el)) continue;
    const text = normalizeText(el.textContent ?? '');
    if (text) return true;
  }
  return false;
}

function noticePeriodDays(profile: Profile): number {
  switch (profile.noticePeriod) {
    case 'Immediate': return 0;
    case '15 days': return 15;
    case '30 days': return 30;
    case '60 days': return 60;
    case '90+ days': return 90;
    default: return 30;
  }
}

function linkedInYesNoAnswer(label: string, profile: Profile): 'yes' | 'no' | undefined {
  const q = label.toLowerCase().trim();
  if (!q) return undefined;
  // Only for clear yes/no questions — not free-text / numeric prompts
  if (/how many|years of|what is|where|which|rate |proficiency|salary|ctc|notice period|enter /i.test(q)) {
    return undefined;
  }
  // Privacy / consent / "By clicking Yes…" → Yes
  if (/privacy|agree|consent|by clicking|data processing|acknowledge|terms of service|terms and conditions/i.test(q)) {
    return 'yes';
  }
  // Hybrid / commute / work-mode comfort questions → Yes
  if (/comfortable|hybrid|commut|work from office|on-?site|onsite|ok with|okay with|willing to (work|come|join|travel)/i.test(q)) {
    return 'yes';
  }
  if (!/^(are you|do you|have you|will you|can you|would you)\b|willing|authorized|sponsorship|relocat|eligible|legally|require|need .*visa/i.test(q)) {
    return undefined;
  }
  if (/sponsor|require (a )?visa|need .*sponsorship/.test(q)) {
    return profile.requiresSponsorship ? 'yes' : 'no';
  }
  if (/relocat/.test(q)) return profile.willingToRelocate === false ? 'no' : 'yes';
  if (/authoriz|legally (able|entitled)|work permit|eligible to work|right to work/.test(q)) {
    return profile.workAuthorization === 'No' ? 'no' : 'yes';
  }
  if (/disabilit|veteran|hispanic|latino|felony|criminal/.test(q)) return 'no';
  return 'yes';
}

/** Numeric Easy Apply answers must satisfy LinkedIn's validation hints (whole number, > 0.0, 0-99). */
function linkedInNumericAnswer(label: string, hint: string, profile: Profile): string | undefined {
  const q = label.toLowerCase();
  const years = profile.totalExperienceYears > 0 ? profile.totalExperienceYears : 2;

  let value: number | undefined;
  if (/percent|percentage|%|marks|cgpa|sgpa|gpa|10th|12th|graduat/.test(q)) {
    const academic = academicAnswer(q, profile);
    if (academic) return academic;
    value = 80;
  } else if (/salary|ctc|compensation|package|per hour|hourly|pay/.test(q) && !/rate your|proficiency/.test(q)) {
    value = profile.expectedCTC ?? profile.currentCTC ?? years;
  } else if (/notice period/.test(q)) {
    value = noticePeriodDays(profile);
  } else if (/\bage\b/.test(q)) {
    value = 25;
  } else if (/rate your|proficiency|1\s*[-–to/]\s*10|scale/i.test(q)) {
    value = Number(proficiencyRating(profile));
  } else if (
    /how many|years|experience|exp\b|months/i.test(q)
    || /whole number|between 0 and 99|between 1 and 99/.test(hint.toLowerCase())
  ) {
    value = years;
  } else {
    // Unknown numeric field — don't invent a value
    return undefined;
  }

  const constraints = `${hint} ${q}`;
  if (/whole number|integer/.test(constraints)) value = Math.round(value);
  if (/larger than 0|greater than 0|more than 0|between 1 and/.test(constraints)) {
    value = Math.max(value, 1);
  }
  if (/between 0 and 99|between 1 and 99/.test(constraints)) {
    value = Math.min(Math.max(value, /between 1/.test(constraints) ? 1 : 0), 99);
  }
  if (/years/.test(q) && value > 50) value = years;

  return String(Number.isInteger(value) ? value : Number(value.toFixed(1)));
}

function isNumericLinkedInField(input: HTMLInputElement, label: string, hint: string): boolean {
  if (input.type === 'number') return true;
  if (/numeric|decimal/i.test(input.getAttribute('inputmode') ?? '')) return true;
  const q = label.toLowerCase();
  // Hint alone is not enough — LinkedIn error text can leak across fields
  if (/how many years|years of (work )?experience|how many months|total (years|experience)|notice period|proficiency|1\s*[-–to/]\s*10/.test(q)) {
    return true;
  }
  if (/whole number|decimal number|between 0 and 99|enter a number/.test(hint.toLowerCase())
    && /year|experience|month|salary|ctc|notice|rate|score|percent|age|how many/i.test(q)) {
    return true;
  }
  return false;
}

function fillLinkedInSelect(select: HTMLSelectElement, label: string, profile: Profile): boolean {
  const options = Array.from(select.options).filter((opt) => {
    const text = normalizeText(opt.textContent ?? '');
    return text && !text.startsWith('select an option') && text !== 'select' && opt.value !== '';
  });
  if (options.length === 0) return false;

  const current = normalizeText(select.selectedOptions[0]?.textContent ?? '');
  if (current && !current.startsWith('select an option') && current !== 'select') return false;

  const getText = (opt: HTMLOptionElement) => opt.textContent ?? '';
  const desired = mapChatbotAnswer(label, profile);
  const wanted = desired ? normalizeText(desired) : '';

  const pick = (predicate: (text: string) => boolean): HTMLOptionElement | undefined =>
    options.find((opt) => predicate(normalizeText(opt.textContent ?? '')));

  let target: HTMLOptionElement | undefined;

  // Preferred cities / locations — fuzzy match against profile city
  if (isLinkedInCityQuestion(label)) {
    target = pickLinkedInCityOption(options, getText, profile);
  }

  // Notice period / availability dropdowns
  if (!target && isLinkedInNoticeAvailabilityQuestion(label)) {
    target = pickLinkedInNoticePeriodOption(options, getText, profile);
  }

  if (!target && wanted) {
    target = pick((text) => text === wanted) ?? pick((text) => text.includes(wanted) || wanted.includes(text));
    // City-like free text vs dropdown options
    if (!target && /location|city|cities|reside|based/i.test(label)) {
      target = pickLinkedInCityOption(options, getText, profile);
    }
  }
  if (!target) {
    const yesNo = linkedInYesNoAnswer(label, profile);
    if (yesNo) {
      target = pick((text) => text === yesNo) ?? pick((text) => text.startsWith(yesNo));
    }
  }
  // Relocate / work permit style questions that didn't match linkedInYesNoAnswer
  if (!target) {
    const q = label.toLowerCase();
    if (/relocat|work permit|authorized|authorised|eligible to work|legally/i.test(q)) {
      const preferYes = /work permit|authorized|authorised|eligible|legally/i.test(q)
        ? profile.workAuthorization !== 'No'
        : profile.willingToRelocate !== false;
      target = pick((text) => text === (preferYes ? 'yes' : 'no'));
    }
  }
  // Binary Yes/No dropdowns (privacy / agree / generic) → Yes
  if (!target) {
    const texts = options.map((o) => normalizeText(o.textContent ?? ''));
    const yesNoOnly = texts.includes('yes') && texts.includes('no')
      && texts.every((t) => t === 'yes' || t === 'no');
    if (yesNoOnly) {
      target = pick((text) => text === 'yes');
    }
  }
  if (!target) return false;

  const proto = HTMLSelectElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(select, target.value);
  else select.value = target.value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return normalizeText(select.selectedOptions[0]?.textContent ?? '') === normalizeText(target.textContent ?? '');
}

/** LinkedIn sometimes renders custom listbox dropdowns instead of native <select>. */
async function fillLinkedInCustomDropdowns(modal: HTMLElement, profile: Profile): Promise<boolean> {
  let filled = false;
  const triggers = Array.from(modal.querySelectorAll<HTMLElement>(
    'button[aria-haspopup="listbox"], [role="combobox"], .artdeco-dropdown__trigger, .fb-dash-form-element button[aria-expanded], select',
  )).filter((el) => {
    if (el.tagName === 'SELECT') return false; // handled by fillLinkedInSelect
    return isVisible(el);
  });

  for (const trigger of triggers) {
    const group = getLinkedInFieldGroup(trigger) ?? trigger.closest('fieldset') ?? trigger.parentElement;
    const label = getLinkedInFieldLabel(trigger)
      || (group?.querySelector('label, legend, .fb-dash-form-element__label, .jobs-easy-apply-form-element__label')?.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim()
      || normalizeText(group?.textContent ?? '').slice(0, 200);
    const current = normalizeText(trigger.textContent ?? '');
    // Skip triggers that already show a real selection (not the placeholder)
    if (
      current
      && !current.includes('select an option')
      && current !== 'select'
      && current !== 'required'
    ) {
      continue;
    }

    forceClick(trigger);
    await sleep(350);

    const options = Array.from(document.querySelectorAll<HTMLElement>(
      '[role="listbox"] [role="option"], [role="option"], .artdeco-dropdown__item, .basic-typeahead__selectable, ul[role="listbox"] li',
    )).filter((el) => isVisible(el) && normalizeText(el.textContent ?? '') && !normalizeText(el.textContent ?? '').startsWith('select'));

    const getText = (el: HTMLElement) => el.textContent ?? '';
    let picked: HTMLElement | undefined;

    if (isLinkedInCityQuestion(label)) {
      picked = pickLinkedInCityOption(options, getText, profile);
    } else if (isLinkedInNoticeAvailabilityQuestion(label)) {
      picked = pickLinkedInNoticePeriodOption(options, getText, profile);
    }

    if (!picked) {
      const desiredRaw = linkedInYesNoAnswer(label, profile)
        ?? mapChatbotAnswer(label, profile)
        ?? (/privacy|agree|consent|by clicking/i.test(label) ? 'yes' : undefined);
      const desired = desiredRaw ? normalizeText(desiredRaw) : '';
      if (desired) {
        picked = options.find((el) => normalizeText(el.textContent ?? '') === desired)
          ?? options.find((el) => {
            const t = normalizeText(el.textContent ?? '');
            return t.startsWith(desired) || t.includes(desired) || desired.includes(t);
          });
      }
      // City free-text vs options
      if (!picked && (/location|city|cities/i.test(label) || desired)) {
        picked = pickLinkedInCityOption(options, getText, profile);
      }
    }
    if (!picked) {
      const yesOpt = options.find((el) => normalizeText(el.textContent ?? '') === 'yes');
      const noOpt = options.find((el) => normalizeText(el.textContent ?? '') === 'no');
      if (yesOpt && noOpt) {
        const q = label.toLowerCase();
        if (/relocat/i.test(q) && profile.willingToRelocate === false) picked = noOpt;
        else if (/work permit|authorized|authorised|eligible|legally/i.test(q) && profile.workAuthorization === 'No') {
          picked = noOpt;
        } else {
          picked = yesOpt;
        }
      }
    }
    if (!picked && options.length === 1) picked = options[0];
    if (!picked) {
      // close dropdown
      forceClick(trigger);
      await sleep(150);
      continue;
    }
    forceClick(picked);
    filled = true;
    emit({
      status: 'searching',
      reason: `LinkedIn: "${label.slice(0, 70)}" → ${normalizeText(picked.textContent ?? '')}`,
    });
    await sleep(250);
  }
  return filled;
}

function clickLinkedInRadio(radio: HTMLInputElement): void {
  if (radio.checked) return;
  const label = (radio.id
    ? document.querySelector<HTMLElement>(`label[for="${CSS.escape(radio.id)}"]`)
    : null)
    ?? (radio.closest('label') as HTMLElement | null)
    ?? (radio.parentElement as HTMLElement | null)
    ?? radio;
  // LinkedIn radios are often opacity:0 — click the visible label text
  forceClick(label);
  if (!radio.checked) {
    try {
      radio.checked = true;
      radio.dispatchEvent(new Event('click', { bubbles: true }));
      radio.dispatchEvent(new Event('input', { bubbles: true }));
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    } catch {
      // ignore
    }
  }
}

function fillLinkedInRadioGroup(group: HTMLElement, label: string, profile: Profile): boolean {
  const radios = Array.from(group.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  if (radios.length === 0) return false;
  if (radios.some((r) => r.checked)) return false;

  // Prefer the real question (legend) over a polluted "Yes" option label
  const question = (() => {
    const legend = group.querySelector('legend')?.textContent
      || group.querySelector('.fb-dash-form-element__label, .jobs-easy-apply-form-element__label')?.textContent
      || '';
    const cleaned = legend.replace(/\s+/g, ' ').trim();
    if (cleaned.length >= 8 && !/^(yes|no)$/i.test(cleaned)) return cleaned;
    return label;
  })();

  const getText = (r: HTMLInputElement) => getRadioLabel(r);
  const texts = radios.map((r) => normalizeText(getRadioLabel(r)));
  const looksLikeNotice = texts.some((t) =>
    /available now|currently serving|one week|two weeks|one month|two months|three months|immediate|15 days|30 days|60 days/i.test(t),
  );

  let target: HTMLInputElement | undefined;

  // Notice period / availability radios (Available now, One month, …)
  if (isLinkedInNoticeAvailabilityQuestion(question) || looksLikeNotice) {
    target = pickLinkedInNoticePeriodOption(radios, getText, profile);
  }

  if (!target) {
    const desired = mapChatbotAnswer(question, profile);
    const wanted = desired ? normalizeText(desired) : '';
    const yesNo = linkedInYesNoAnswer(question, profile)
      ?? (/comfortable|hybrid|commut|office|willing|authorized|relocat|agree|work permit/i.test(question)
        ? 'yes' as const
        : undefined);

    const byLabel = (needle: string) => radios.find((r) => {
      const text = normalizeText(getRadioLabel(r));
      return needle && (text === needle || text.startsWith(`${needle} `) || text.includes(needle));
    });

    const yesNoOnly = texts.length >= 2 && texts.every((t) => t === 'yes' || t === 'no' || t === 'true' || t === 'false');

    target = (wanted ? byLabel(wanted) : undefined)
      ?? (yesNo ? byLabel(yesNo) : undefined)
      ?? (yesNoOnly ? byLabel('yes') ?? byLabel('true') : undefined);
  }

  if (!target) return false;
  clickLinkedInRadio(target);
  return true;
}

function fillLinkedInCheckboxes(modal: HTMLElement): void {
  for (const cb of modal.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    // Checkboxes may be opacity:0 — still interact via label
    const label = getLinkedInFieldLabel(cb);
    if (cb.checked) continue;
    // Only tick required consents; never auto-follow companies
    if (/follow /.test(label)) continue;
    const required = cb.required
      || cb.getAttribute('aria-required') === 'true'
      || /i agree|acknowledge|consent|terms|privacy|certify|confirm/.test(label);
    if (!required) continue;
    const clickTarget = (cb.id
      ? document.querySelector<HTMLElement>(`label[for="${CSS.escape(cb.id)}"]`)
      : null)
      ?? (cb.closest('label') as HTMLElement | null)
      ?? cb;
    forceClick(clickTarget);
  }
}

async function fillLinkedInEasyApplyFields(profile: Profile): Promise<boolean> {
  const modal = getLinkedInEasyApplyModal();
  if (!modal) return false;

  let filled = false;
  const answeredGroups = new WeakSet<HTMLElement>();

  for (const el of modal.querySelectorAll<HTMLElement>('input, select, textarea')) {
    const tag = el.tagName.toLowerCase();
    const type = (el as HTMLInputElement).type;
    if (type === 'file' || type === 'hidden' || type === 'submit' || type === 'button') continue;
    if (type === 'checkbox') continue;

    // Radios are often opacity:0 — do NOT skip them via isVisible
    if (type !== 'radio' && !isVisible(el)) continue;

    const label = getLinkedInFieldLabel(el);
    const hint = getLinkedInFieldError(el);
    const hasError = Boolean(hint);

    if (tag === 'select') {
      if (fillLinkedInSelect(el as HTMLSelectElement, label, profile)) {
        filled = true;
        emit({
          status: 'searching',
          reason: `LinkedIn: "${label.slice(0, 70)}" → ${(el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? ''}`,
        });
      }
      continue;
    }

    if (type === 'radio') {
      const group = (el.closest('fieldset') as HTMLElement | null)
        ?? getLinkedInFieldGroup(el)
        ?? el.parentElement;
      if (group && answeredGroups.has(group)) continue;
      if (group && fillLinkedInRadioGroup(group, label, profile)) {
        answeredGroups.add(group);
        filled = true;
        const chosen = group.querySelector<HTMLInputElement>('input[type="radio"]:checked');
        emit({
          status: 'searching',
          reason: `LinkedIn: "${(label || 'Yes/No').slice(0, 70)}" → ${normalizeText(chosen ? getRadioLabel(chosen) : 'yes')}`,
        });
      }
      continue;
    }

    const input = el as HTMLInputElement | HTMLTextAreaElement;
    const current = input.value.trim();
    // Keep valid answers; only rewrite when LinkedIn flagged the field
    if (current && !hasError) continue;

    let value: string | undefined;
    if (tag === 'textarea') {
      value = mapChatbotAnswer(label, profile) ?? profile.coverLetterTemplate;
    } else if (isNumericLinkedInField(input as HTMLInputElement, label, hint)) {
      value = linkedInNumericAnswer(label, hint, profile);
    } else if (type === 'email') {
      value = profile.email;
    } else if (type === 'tel' || /phone|mobile/.test(label)) {
      value = profile.phone;
    } else {
      value = mapChatbotAnswer(label, profile);
      if (!value && /city|location|reside|based/.test(label.toLowerCase())) value = profile.currentLocation;
      if (!value && /name/.test(label.toLowerCase())) value = profile.fullName;
    }

    if (!value) continue;
    if (value === current) continue;

    setReactInputValue(input, value);
    filled = true;
    emit({
      status: 'searching',
      reason: `LinkedIn: "${label.slice(0, 70)}" → ${value}`,
    });
    await sleep(120);

    // Typeahead fields (city) need a suggestion committed
    if (/city|location/.test(label.toLowerCase())) {
      await sleep(500);
      const option = document.querySelector(
        '.basic-typeahead__triggered-content [role="option"], [role="listbox"] [role="option"]',
      ) as HTMLElement | null;
      if (option && isVisible(option)) forceClick(option);
    }
  }

  fillLinkedInCheckboxes(modal);
  if (await fillLinkedInCustomDropdowns(modal, profile)) filled = true;
  return filled;
}

async function fillLinkedInStepUntilValid(
  profile: Profile,
  jobTitle: string,
  company: string,
): Promise<boolean> {
  for (let pass = 0; pass < 4 && !isStopped(); pass++) {
    const filled = await fillLinkedInEasyApplyFields(profile);
    if (pass === 0 && filled) {
      emit({ status: 'searching', jobTitle, company, reason: 'Answering Easy Apply questions...' });
    }
    await sleep(400);
    if (!linkedInModalHasFieldErrors()) return true;
    if (!filled && pass > 0) break;
  }
  return !linkedInModalHasFieldErrors();
}

async function completeLinkedInEasyApply(
  profile: Profile,
  jobTitle: string,
  company: string,
): Promise<'applied' | 'skipped' | 'failed'> {
  // Clear leftover success UI from a previous job before we start
  await dismissLinkedInPostApplyOverlay();

  const opened = getLinkedInEasyApplyModal();
  if (!opened) {
    // Only count applied if THIS job's top card shows Applied (not a leftover modal)
    if (linkedInTopCardShowsApplied()) return 'applied';
    return 'failed';
  }

  let stuckSteps = 0;
  let didSubmit = false;

  for (let step = 0; step < 16 && !isStopped(); step++) {
    const valid = await fillLinkedInStepUntilValid(profile, jobTitle, company);

    const submit = findLinkedInModalActionButton([
      'Submit application',
      'Submit',
      'Send application',
    ]);
    if (submit) {
      emit({ status: 'searching', jobTitle, company, reason: 'Submitting Easy Apply...' });
      forceClick(submit);
      didSubmit = true;
      await sleep(800);

      // LinkedIn sometimes asks to confirm again
      const confirm = findLinkedInModalActionButton(['Submit application', 'Submit']);
      if (confirm && confirm !== submit) {
        forceClick(confirm);
      }

      const ok = await waitForLinkedInApplySuccess(8000, company);
      if (ok) {
        await dismissLinkedInPostApplyOverlay();
        return 'applied';
      }
      if (detectLinkedInApplyError()) return 'failed';
      // After a real Submit click: Easy Apply modal closed or top card says Applied
      if (!getLinkedInEasyApplyModal() || linkedInTopCardShowsApplied()) {
        await dismissLinkedInPostApplyOverlay();
        return 'applied';
      }
      return 'failed';
    }

    const next = findLinkedInModalActionButton([
      'Continue to next step',
      'Review your application',
      'Next',
      'Continue',
      'Review',
    ]);
    if (next) {
      forceClick(next);
      await randomDelay(900, 1600);

      // Same step still showing validation errors — answer them, then retry once
      if (linkedInModalHasFieldErrors()) {
        const fixed = await fillLinkedInStepUntilValid(profile, jobTitle, company);
        if (fixed) {
          const retry = findLinkedInModalActionButton([
            'Continue to next step',
            'Review your application',
            'Next',
            'Continue',
            'Review',
          ]);
          if (retry) {
            forceClick(retry);
            await randomDelay(900, 1600);
          }
        }
        if (linkedInModalHasFieldErrors()) {
          stuckSteps++;
          if (stuckSteps >= 2) {
            await abandonLinkedInEasyApply();
            return 'skipped';
          }
        }
      } else if (!valid) {
        stuckSteps = 0;
      }
      continue;
    }

    // Unanswered required fields — skip rather than hang
    await abandonLinkedInEasyApply();
    return didSubmit && linkedInTopCardShowsApplied() ? 'applied' : 'skipped';
  }

  await abandonLinkedInEasyApply();
  return didSubmit && linkedInTopCardShowsApplied() ? 'applied' : 'failed';
}

async function handleLinkedInCompanySiteApply(
  state: LinkedInRunState,
  jobTitle: string,
  company: string,
  control: HTMLElement,
  listingUrl?: string,
): Promise<void> {
  const jobUrl = listingUrl || getLinkedInJobListingUrl() || window.location.href.split('#')[0];
  const lead: ExternalCompanyLead = {
    jobTitle,
    company,
    naukriUrl: jobUrl,
    skipReason: 'Apply on company website',
    sourceType: 'company-site',
    capturedAt: new Date().toISOString(),
  };

  // Always record the lead immediately so CSV/email include it even if URL capture is slow
  recordExternalApplyLead(lead);

  state.counts.skipped++;
  state.jobIndex += 1;
  saveLinkedInState(state);
  emitLinkedInCounters(state.counts);
  releasePageClaim();
  sessionStorage.removeItem(EXEC_KEY);

  emit({
    status: 'skipped',
    jobTitle,
    company,
    reason: 'Opening company website — will capture URL for CSV...',
  });

  let externalHref = getExternalApplyHref(control);
  // LinkedIn sometimes embeds the destination in aria / data attrs only
  if (!externalHref) {
    const aria = control.getAttribute('aria-label') ?? '';
    const urlMatch = aria.match(/https?:\/\/[^\s]+/i);
    if (urlMatch) externalHref = urlMatch[0];
  }

  const returnUrl = buildLinkedInSearchUrl(state.criteria);
  await handleCompanySiteApply(state.runId, returnUrl, lead, control, externalHref);

  // Keep pending state so resume continues after company tab capture
  saveLinkedInState(state);
}

async function runLinkedIn(profile: Profile, criteria: SearchCriteria): Promise<void> {
  if (!window.location.href.includes('linkedin.com/jobs')) {
    saveLinkedInState({
      platform: 'linkedin',
      runId: currentRunId!,
      profile,
      criteria: { ...criteria, platform: 'linkedin' },
      jobIndex: 0,
      counts: { applied: 0, skipped: 0, failed: 0 },
      processedJobKeys: [],
    });
    window.location.href = buildLinkedInSearchUrl(criteria);
    return;
  }

  const state = loadLinkedInState() ?? {
    platform: 'linkedin' as const,
    runId: currentRunId!,
    profile,
    criteria: { ...criteria, platform: 'linkedin' as const },
    jobIndex: 0,
    counts: { applied: 0, skipped: 0, failed: 0 },
    processedJobKeys: [] as string[],
  };
  state.profile = profile;
  state.criteria = { ...criteria, platform: 'linkedin' };
  if (!state.processedJobKeys) state.processedJobKeys = [];
  currentRunId = state.runId;

  // LinkedIn post-apply interstitial (/jobs/search/post-apply/...) — leave immediately
  if (/\/jobs\/search\/post-apply\//i.test(window.location.pathname)) {
    await dismissLinkedInPostApplyOverlay();
    emit({ status: 'searching', reason: 'Leaving LinkedIn post-apply page — back to job list...' });
    saveLinkedInState(state);
    releasePageClaim();
    sessionStorage.removeItem(EXEC_KEY);
    window.location.href = buildLinkedInSearchUrl(state.criteria);
    return;
  }

  sessionStorage.removeItem(`job-autoapply-external-pending-${state.runId}`);
  await dismissLinkedInPostApplyOverlay();
  dismissLinkedInSaveApplicationPrompt();
  await sleep(200);

  const passId = automationPassId;
  const stillThisPass = () => passId === automationPassId && !isStopped();

  if (state.counts.applied >= state.criteria.dailyApplicationCap) {
    emit({
      status: 'searching',
      reason: `Daily cap reached (${state.counts.applied}/${state.criteria.dailyApplicationCap})`,
    });
    emitLinkedInCounters(state.counts);
    finish(state.counts);
    return;
  }

  emit({ status: 'searching', reason: `Scanning LinkedIn job results (index ${state.jobIndex})...` });
  await randomDelay(1500, 2800);

  let cards = await collectLinkedInJobCards();

  if (cards.length === 0) {
    // Empty results (e.g. Past 24h) — widen filters before giving up when under daily cap
    if (state.counts.applied < state.criteria.dailyApplicationCap) {
      if (await goToLinkedInNextPage(state)) {
        if (!stillThisPass()) return;
        await runLinkedIn(profile, criteria);
        return;
      }
      if (await widenLinkedInDateFilter(state)) return;
    }
    emit({
      status: 'searching',
      reason: 'No LinkedIn job cards left. Try different keywords or a wider date filter.',
    });
    finish(state.counts);
    return;
  }

  for (let i = state.jobIndex; i < cards.length && stillThisPass(); i++) {
    // Reload counts from storage in case another pass updated them
    const fresh = loadLinkedInState();
    if (fresh?.counts) state.counts = fresh.counts;
    if (fresh?.processedJobKeys) state.processedJobKeys = fresh.processedJobKeys;

    if (state.counts.applied >= state.criteria.dailyApplicationCap) break;

    const card = cards[i];
    let { jobTitle, company } = getLinkedInJobMeta(card);
    const key = linkedInJobKey(card, jobTitle, company);
    const listingUrl = getLinkedInJobListingUrl(card);

    if (state.processedJobKeys.includes(key)) {
      state.jobIndex = i + 1;
      saveLinkedInState(state);
      continue;
    }

    if ((card.textContent ?? '').includes('Applied')) {
      state.counts.skipped++;
      state.processedJobKeys.push(key);
      state.jobIndex = i + 1;
      recordSkippedLead(jobTitle, company, 'already applied', listingUrl);
      emit({ status: 'skipped', jobTitle, company, reason: 'already applied' });
      saveLinkedInState(state);
      emitLinkedInCounters(state.counts);
      continue;
    }

    state.jobIndex = i;
    saveLinkedInState(state);

    card.scrollIntoView({ block: 'center', behavior: 'instant' });
    forceClick(card);
    await randomDelay(1800, 2800);
    if (!stillThisPass()) return;

    // Prefer detail-pane meta, but never overwrite a good card value with "Unknown"
    ({ jobTitle, company } = mergeLinkedInJobMeta(
      { jobTitle, company },
      getLinkedInDetailJobMeta(),
    ));

    // Never let a previous job's success modal inflate the applied count
    await dismissLinkedInPostApplyOverlay();
    if (!stillThisPass()) return;

    // Wait for top-card Apply / Easy Apply to render after card select
    let controls = findLinkedInApplyControls();
    const waitStart = Date.now();
    while (!controls.external && !controls.easyApply && Date.now() - waitStart < 6000 && stillThisPass()) {
      await sleep(300);
      controls = findLinkedInApplyControls();
    }
    if (!stillThisPass()) return;

    let { external, easyApply } = controls;

    // Prefer Easy Apply whenever it is available (even if LinkedIn also shows offsite Apply)
    if (easyApply && isLinkedInEasyApplyControl(easyApply)) {
      // fall through to Easy Apply path below
    } else if (external && isLinkedInOffsiteApplyControl(external)) {
      // Same as Naukri company-site: always capture company URL for the report
      state.processedJobKeys.push(key);
      saveLinkedInState(state);
      await handleLinkedInCompanySiteApply(state, jobTitle, company, external, listingUrl);
      return; // resume continues after company-tab capture
    }

    if (!easyApply || !isLinkedInEasyApplyControl(easyApply)) {
      const fallbackApply = external ?? findLinkedInExternalApplyControl();
      // Any remaining top-card Apply that isn't Easy Apply → company-site capture
      let plainApply: HTMLElement | null = null;
      if (!fallbackApply) {
        const scope = getLinkedInApplyScope();
        for (const el of scope.querySelectorAll<HTMLElement>('button, a')) {
          if (!isVisible(el)) continue;
          const t = normalizeText(el.textContent ?? '');
          if (t === 'apply' || t.startsWith('apply ')) {
            if (!isLinkedInEasyApplyControl(el)) {
              plainApply = el;
              break;
            }
          }
        }
      }
      const offsiteBtn = fallbackApply ?? plainApply;
      if (offsiteBtn) {
        state.processedJobKeys.push(key);
        saveLinkedInState(state);
        await handleLinkedInCompanySiteApply(state, jobTitle, company, offsiteBtn, listingUrl);
        return;
      }

      state.counts.skipped++;
      state.processedJobKeys.push(key);
      state.jobIndex = i + 1;
      recordSkippedLead(jobTitle, company, 'No Apply button found', listingUrl);
      emit({ status: 'skipped', jobTitle, company, reason: 'No Apply button found' });
      saveLinkedInState(state);
      emitLinkedInCounters(state.counts);
      continue;
    }

    // Guard: never treat a real Easy Apply control as company-site
    if (isLinkedInOffsiteApplyControl(easyApply)) {
      state.processedJobKeys.push(key);
      saveLinkedInState(state);
      await handleLinkedInCompanySiteApply(state, jobTitle, company, easyApply, listingUrl);
      return;
    }

    // Re-check cap before starting another Easy Apply (force-resume races)
    if (state.counts.applied >= state.criteria.dailyApplicationCap) break;

    emit({ status: 'searching', jobTitle, company, reason: 'Opening Easy Apply...' });
    forceClick(easyApply);
    await randomDelay(1200, 2200);
    if (!stillThisPass()) return;

    // Wait for modal — if none opens, this was likely offsite Apply
    const modalWaitStart = Date.now();
    while (!getLinkedInEasyApplyModal() && Date.now() - modalWaitStart < 4500 && stillThisPass()) {
      await sleep(250);
    }
    if (!stillThisPass()) return;

    if (!getLinkedInEasyApplyModal()) {
      // Only count applied when THIS job's detail pane shows Applied — not a leftover modal
      if (linkedInTopCardShowsApplied()) {
        state.counts.skipped++;
        state.processedJobKeys.push(key);
        state.jobIndex = i + 1;
        recordSkippedLead(jobTitle, company, 'already applied', listingUrl);
        emit({ status: 'skipped', jobTitle, company, reason: 'already applied' });
        saveLinkedInState(state);
        emitLinkedInCounters(state.counts);
        continue;
      }

      // Retry Easy Apply once — LinkedIn sometimes lags
      forceClick(easyApply);
      await sleep(2000);
      if (getLinkedInEasyApplyModal()) {
        // fall through to completeLinkedInEasyApply below
      } else {
        const again = findLinkedInApplyControls();
        if (again.easyApply && isLinkedInEasyApplyControl(again.easyApply)) {
          forceClick(again.easyApply);
          await sleep(2000);
        }
        if (!getLinkedInEasyApplyModal()) {
          if (linkedInTopCardShowsApplied()) {
            state.counts.skipped++;
            state.processedJobKeys.push(key);
            state.jobIndex = i + 1;
            recordSkippedLead(jobTitle, company, 'already applied', listingUrl);
            emit({ status: 'skipped', jobTitle, company, reason: 'already applied' });
            saveLinkedInState(state);
            emitLinkedInCounters(state.counts);
            continue;
          }
          const offsite = again.external && isLinkedInOffsiteApplyControl(again.external)
            ? again.external
            : null;
          if (offsite) {
            state.processedJobKeys.push(key);
            saveLinkedInState(state);
            await handleLinkedInCompanySiteApply(state, jobTitle, company, offsite, listingUrl);
            return;
          }
          state.counts.skipped++;
          state.processedJobKeys.push(key);
          state.jobIndex = i + 1;
          recordSkippedLead(jobTitle, company, 'Easy Apply modal did not open', listingUrl);
          emit({ status: 'skipped', jobTitle, company, reason: 'Easy Apply modal did not open' });
          saveLinkedInState(state);
          emitLinkedInCounters(state.counts);
          continue;
        }
      }
    }

    const outcome = await completeLinkedInEasyApply(profile, jobTitle, company);
    if (!stillThisPass()) return;
    state.processedJobKeys.push(key);
    state.jobIndex = i + 1;

    if (outcome === 'applied') {
      state.counts.applied++;
      saveLinkedInState(state);
      emitLinkedInCounters(state.counts);
      recordExternalApplyLead({
        jobTitle,
        company,
        naukriUrl: listingUrl,
        skipReason: 'Applied',
        sourceType: 'applied',
        capturedAt: new Date().toISOString(),
      });
      emit({ status: 'applied', jobTitle, company });
      await dismissLinkedInPostApplyOverlay();
      if (state.counts.applied >= state.criteria.dailyApplicationCap) {
        emit({
          status: 'searching',
          reason: `Target reached (${state.counts.applied}/${state.criteria.dailyApplicationCap} applied)`,
        });
        finish(state.counts);
        return;
      }
    } else if (outcome === 'skipped') {
      state.counts.skipped++;
      // If top card already says Applied, record as already applied (not a new apply)
      if (linkedInTopCardShowsApplied()) {
        recordSkippedLead(jobTitle, company, 'already applied', listingUrl);
        emit({ status: 'skipped', jobTitle, company, reason: 'already applied' });
      } else {
        recordSkippedLead(jobTitle, company, 'could not complete Easy Apply form', listingUrl);
        emit({ status: 'skipped', jobTitle, company, reason: 'could not complete Easy Apply form' });
      }
      emitLinkedInCounters(state.counts);
    } else {
      if (linkedInTopCardShowsApplied()) {
        // Submitted earlier / already done — do not count as a new apply
        state.counts.skipped++;
        recordSkippedLead(jobTitle, company, 'already applied', listingUrl);
        emit({ status: 'skipped', jobTitle, company, reason: 'already applied' });
        emitLinkedInCounters(state.counts);
        await dismissLinkedInPostApplyOverlay();
      } else {
        state.counts.failed++;
        emit({ status: 'failed', jobTitle, company, reason: 'submit confirmation not detected' });
        emitLinkedInCounters(state.counts);
        await abandonLinkedInEasyApply();
      }
    }

    saveLinkedInState(state);
    // Short pause between jobs — no need to sit on the success modal
    await randomDelay(800, 1500);
  }

  if (!stillThisPass()) return;

  if (isStopped()) {
    emit({ status: 'interrupted', reason: 'Stopped by user' });
    finish(state.counts);
    return;
  }

  if (state.counts.applied >= state.criteria.dailyApplicationCap) {
    emit({
      status: 'searching',
      reason: `Daily cap reached (${state.counts.applied}/${state.criteria.dailyApplicationCap})`,
    });
    emitLinkedInCounters(state.counts);
    finish(state.counts);
    return;
  }

  // More pages available — continue in this same pass (do not rely on resume)
  if (await goToLinkedInNextPage(state)) {
    if (!stillThisPass()) return;
    await runLinkedIn(profile, criteria);
    return;
  }

  // Under cap with no more pages — widen Past 24h → Past week → Any time
  if (await widenLinkedInDateFilter(state)) {
    return;
  }

  emit({
    status: 'searching',
    reason: `No more LinkedIn jobs to process (${state.counts.applied} applied / cap ${state.criteria.dailyApplicationCap})`,
  });
  finish(state.counts);
}

async function startAutomation(
  profile: Profile,
  criteria: SearchCriteria,
  runId: string,
  forceFresh = false,
): Promise<void> {
  if (forceFresh) {
    clearAllRunState();
    clearStopFlag();
    automationActive = false;
    if (criteria.platform === 'naukri') clearNaukriAttemptCounters();
  }

  if (!forceFresh && (automationActive || isStopped())) return;

  const isResume = Boolean(sessionStorage.getItem(PENDING_KEY));
  const runKey = `job-autoapply-run-${runId}`;
  if (!forceFresh && !isResume && sessionStorage.getItem(runKey)) return;
  if (!isResume && !beginExecution(runId, forceFresh)) return;

  automationActive = true;
  clearStopFlag();
  currentRunId = runId;
  lastProgressAt = Date.now();
  startStallWatchdog();
  if (!isResume || forceFresh) {
    sessionStorage.removeItem(PENDING_KEY);
    if (criteria.platform === 'naukri') clearNaukriAttemptCounters();
  }
  sessionStorage.setItem(runKey, '1');

  emit({ status: 'searching', reason: 'Automation started on this page...' });

  const run = criteria.platform === 'naukri'
    ? runNaukri(profile, criteria)
    : runLinkedIn(profile, criteria);

  await run.catch((err: Error) => {
    emit({ status: 'failed', reason: err.message });
    finish({ applied: 0, skipped: 0, failed: 1 });
  }).finally(() => {
    if (!sessionStorage.getItem(PENDING_KEY)) {
      sessionStorage.removeItem(runKey);
      sessionStorage.removeItem(EXEC_KEY);
    }
  });
}

async function resumePendingRun(_force = false): Promise<void> {
  if (isStopped()) {
    haltAutomationLocally();
    return;
  }
  // Company-site tab still open — stay parked even for forced resumes
  if (isExternalPauseActive()) {
    emit({
      status: 'searching',
      reason: 'Paused — waiting for company website tab to finish before next job',
    });
    return;
  }
  // Finished runs must never restart via force-resume
  const finishedKey = `job-autoapply-finished-${currentRunId || loadNaukriState()?.runId || loadLinkedInState()?.runId || 'none'}`;
  if (sessionStorage.getItem(finishedKey) === '1') {
    sessionStorage.removeItem(PENDING_KEY);
    automationActive = false;
    return;
  }
  // Ignore overlapping resumes while a pass is in progress; forced resume clears a hung pass
  if (automationActive) {
    if (!_force) return;
    automationPassId += 1;
    automationActive = false;
  }

  const linkedInState = loadLinkedInState();
  if (linkedInState) {
    if (isStopped()) {
      haltAutomationLocally();
      return;
    }
    automationActive = true;
    currentRunId = linkedInState.runId;
    lastProgressAt = Date.now();
    startStallWatchdog();
    try {
      if (window.location.hostname.includes('linkedin.com') && window.location.href.includes('/jobs')) {
        sessionStorage.removeItem(`job-autoapply-external-pending-${linkedInState.runId}`);
        emit({ status: 'searching', reason: 'Resuming LinkedIn job list...' });
        await runLinkedIn(linkedInState.profile, linkedInState.criteria);
      } else {
        saveLinkedInState(linkedInState);
        window.location.href = buildLinkedInSearchUrl(linkedInState.criteria);
      }
    } catch (err) {
      emit({ status: 'failed', reason: (err as Error).message });
      finish(linkedInState.counts);
    } finally {
      automationActive = false;
    }
    return;
  }

  const naukriState = loadNaukriState();
  if (naukriState) {
    if (isStopped()) {
      haltAutomationLocally();
      return;
    }
    automationActive = true;
    currentRunId = naukriState.runId;
    lastProgressAt = Date.now();
    startStallWatchdog();

    try {
      const postApply = sessionStorage.getItem(`job-autoapply-post-apply-${naukriState.runId}`) === '1';

      // The job page landed — the navigation intent is satisfied and the open budget, which
      // exists for postings that never load, must not count this job as unopenable.
      if (isNaukriJobDetailPage()) {
        clearNaukriNavIntent();
        const openedUrl = naukriState.currentDetailUrl;
        if (openedUrl) {
          sessionStorage.removeItem(`job-autoapply-open-count-${normalizeJobUrl(openedUrl)}`);
        }
      }

      releasePageClaim();
      sessionStorage.removeItem(EXEC_KEY);

      // Already applied (409xxx) — the application went through, never report it as rejected
      if (detectNaukriAlreadyAppliedCode()) {
        emit({
          status: 'searching',
          jobTitle: naukriState.jobTitle,
          company: naukriState.company,
          reason: 'Naukri reports this job as already applied — counting it as applied',
        });
        await finalizeNaukriApplication(naukriState);
        return;
      }

      // saveApply with multiApplyResp 406 / Oops incomplete — skip, do NOT count Applied
      if (detectNaukriApplyRejected()) {
        if (!naukriState.jobTitle) {
          naukriState.jobTitle = naukriJobTitleFromApplyUrl(window.location.href) ?? undefined;
        }
        skipNaukriJobAndAdvance(
          naukriState,
          naukriApplyRejectionReason(),
          naukriState.currentDetailUrl,
        );
        return;
      }

      // saveApply with multiApplyResp 200 / green Applied banner
      if (detectNaukriApplyAcceptedPage() || (parseNaukriMultiApplyResp()?.code === 200)) {
        await finalizeNaukriApplication(naukriState);
        return;
      }

      if (isNaukriCompanySiteConfirmationPage()) {
        if (detectNaukriApplySuccess() || headerShowsAppliedBadge()) {
          await finalizeNaukriApplication(naukriState);
          return;
        }
        emit({
          status: 'searching',
          jobTitle: naukriState.jobTitle,
          company: naukriState.company,
          reason: 'Company-site confirmation reached — capturing company URL from new tab...',
        });
        notifyCompanyRedirectConfirmation(buildNaukriSearchUrl(naukriState.criteria));
        return;
      }

      if (isNaukriErrorPage()) {
        // Always mark the intended job processed and move forward — never reopen it
        skipNaukriJobAndAdvance(
          naukriState,
          'Naukri page error / 404 — skipped',
          naukriState.currentDetailUrl,
        );
        return;
      }

      // Back on search results: always continue the list (stale phase=detail caused freezes)
      if (isNaukriSearchPage()) {
        const postApplyFlag =
          sessionStorage.getItem(`job-autoapply-post-apply-${naukriState.runId}`) === '1';

        // After Apply click, Naukri may bounce to the list. Re-open the same job to VERIFY
        // Applied state — never assume success (simple Apply often never registered).
        if (postApplyFlag && naukriState.currentDetailUrl) {
          const verifyKey = `job-autoapply-verify-apply-${naukriState.runId}-${normalizeJobUrl(naukriState.currentDetailUrl)}`;
          const verifyTries = Number(sessionStorage.getItem(verifyKey) || '0');
          if (verifyTries < 1) {
            sessionStorage.setItem(verifyKey, String(verifyTries + 1));
            emit({
              status: 'searching',
              jobTitle: naukriState.jobTitle,
              company: naukriState.company,
              reason: 'Returned to list after Apply — reopening job to verify...',
            });
            naukriState.phase = 'detail';
            saveNaukriState(naukriState);
            window.location.href = naukriState.currentDetailUrl;
            return;
          }
          sessionStorage.removeItem(`job-autoapply-post-apply-${naukriState.runId}`);
          skipNaukriJobAndAdvance(
            naukriState,
            'could not confirm application',
            naukriState.currentDetailUrl,
          );
          return;
        }

        // Bounced to list without finishing Apply — REOPEN the job to finish questions /
        // capture company-site. Do NOT skip here (that abandoned Mirafra/Yash mid-flow).
        if (naukriState.phase === 'detail' && naukriState.currentDetailUrl && !postApplyFlag) {
          const bouncedUrl = naukriState.currentDetailUrl;
          const normalizedBounce = normalizeJobUrl(bouncedUrl);
          const bounceKey = `job-autoapply-bounce-${naukriState.runId}-${normalizedBounce}`;
          const bounces = Number(sessionStorage.getItem(bounceKey) || '0');
          const alreadyHandled = isNaukriJobHandled(
            naukriState,
            bouncedUrl,
            naukriState.jobTitle,
            naukriState.company,
          );

          // The job open may simply not have landed yet (a forced resume arrived while the
          // list page was still on screen). Give the navigation time instead of counting it
          // as a bounce — that is what skipped jobs the run never even opened.
          const navIntent = readNaukriNavIntent();
          if (
            !alreadyHandled
            && navIntent
            && navIntent.url === normalizedBounce
            && Date.now() - navIntent.at < NAUKRI_NAV_INTENT_TTL_MS
            && navIntent.retries < NAUKRI_MAX_NAV_RETRIES
          ) {
            emit({
              status: 'searching',
              jobTitle: naukriState.jobTitle,
              company: naukriState.company,
              reason: 'Job page has not loaded yet — waiting before retrying...',
            });
            await sleep(3000);
            if (isNaukriJobDetailPage() || isStopped()) return;
            noteNaukriNavIntent(normalizedBounce, navIntent.retries + 1);
            naukriState.phase = 'detail';
            saveNaukriState(naukriState);
            window.location.href = bouncedUrl;
            return;
          }

          if (bounces < NAUKRI_MAX_BOUNCE_REOPENS && !alreadyHandled) {
            sessionStorage.setItem(bounceKey, String(bounces + 1));
            emit({
              status: 'searching',
              jobTitle: naukriState.jobTitle,
              company: naukriState.company,
              reason: `Returned to list early — reopening job to finish Apply (attempt ${bounces + 1}/${NAUKRI_MAX_BOUNCE_REOPENS})...`,
            });
            naukriState.phase = 'detail';
            saveNaukriState(naukriState);
            // Bounce recovery is not a fresh attempt — it must not burn the open budget,
            // otherwise applyable jobs got skipped as "already attempted".
            await sleep(2500);
            noteNaukriNavIntent(normalizedBounce);
            window.location.href = bouncedUrl;
            return;
          }

          if (alreadyHandled) {
            naukriState.phase = 'list';
            naukriState.currentDetailUrl = undefined;
            saveNaukriState(naukriState);
            emit({ status: 'searching', reason: 'Resuming Naukri job list...' });
            await runNaukri(naukriState.profile, naukriState.criteria);
            return;
          }

          // Exhausted recovery attempts — skip once (deduped) with an honest reason
          skipNaukriJobAndAdvance(
            naukriState,
            'Naukri kept returning to the list before Apply finished — skipped',
            bouncedUrl,
          );
          return;
        }

        sessionStorage.removeItem(`job-autoapply-external-pending-${naukriState.runId}`);
        sessionStorage.removeItem(`job-autoapply-post-apply-${naukriState.runId}`);
        naukriState.phase = 'list';
        naukriState.jobTitle = undefined;
        naukriState.company = undefined;
        naukriState.currentDetailUrl = undefined;
        saveNaukriState(naukriState);
        emit({ status: 'searching', reason: 'Resuming Naukri job list...' });
        await runNaukri(naukriState.profile, naukriState.criteria);
        return;
      }

      if (naukriState.phase === 'detail' && detectNaukriApplySuccess()) {
        await finalizeNaukriApplication(naukriState);
        return;
      }

      // Fresh job page — click Apply first, never skip to form handling
      if (naukriState.phase === 'detail' && !postApply && isNaukriJobDetailPage()) {
        await applyOnNaukriDetailPage(naukriState.profile, naukriState);
        return;
      }

      if (naukriState.phase === 'detail' && postApply) {
        // Click never registered — retry Apply instead of waiting 15s to skip
        if (isApplyButtonStillOnPage() && !getNaukriQuestionModal() && !findNaukriChatInput(document)) {
          sessionStorage.removeItem(`job-autoapply-post-apply-${naukriState.runId}`);
          await applyOnNaukriDetailPage(naukriState.profile, naukriState);
          return;
        }

        emit({
          status: 'searching',
          jobTitle: naukriState.jobTitle,
          company: naukriState.company,
          reason: 'Checking application confirmation...',
        });

        if (await waitForNaukriApplySuccess(3000) || headerShowsAppliedBadge()) {
          await finalizeNaukriApplication(naukriState);
          return;
        }

        if (getNaukriQuestionModal() || findNaukriChatInput(document)) {
          const outcome = await waitForApplyOutcome(
            naukriState.profile,
            25000,
            naukriState.jobTitle,
            naukriState.company,
          );
          if (outcome === 'applied') {
            await finalizeNaukriApplication(naukriState);
            return;
          }
          if (outcome === 'already') {
            markJobProcessed(naukriState, naukriState.currentDetailUrl ?? window.location.href);
            naukriState.counts.skipped++;
            recordSkippedLead(
              naukriState.jobTitle,
              naukriState.company,
              'already applied to this company',
              naukriState.currentDetailUrl ?? normalizeJobUrl(window.location.href),
            );
            emit({ status: 'skipped', jobTitle: naukriState.jobTitle, company: naukriState.company, reason: 'already applied to this company' });
            sessionStorage.removeItem(`job-autoapply-post-apply-${naukriState.runId}`);
            returnToNaukriSearch(naukriState, naukriState.jobIndex + 1);
            return;
          }
        }

        if (await waitForNaukriApplySuccess(10000) || headerShowsAppliedBadge()) {
          await finalizeNaukriApplication(naukriState);
          return;
        }

        if (isNaukriJobDetailPage()) {
          await applyOnNaukriDetailPage(naukriState.profile, naukriState);
          return;
        }

        markJobProcessed(naukriState, naukriState.currentDetailUrl ?? window.location.href);
        naukriState.counts.skipped++;
        recordSkippedLead(
          naukriState.jobTitle,
          naukriState.company,
          'could not confirm application after apply',
          naukriState.currentDetailUrl ?? normalizeJobUrl(window.location.href),
        );
        emit({
          status: 'skipped',
          jobTitle: naukriState.jobTitle,
          company: naukriState.company,
          reason: 'could not confirm application after apply',
        });
        sessionStorage.removeItem(`job-autoapply-post-apply-${naukriState.runId}`);
        saveNaukriState(naukriState);
        returnToNaukriSearch(naukriState, naukriState.jobIndex + 1);
        return;
      }

      // Confirmation redirect or Applied badge — count success before treating as stuck
      if (
        detectNaukriApplySuccess()
        || isNaukriApplyConfirmationPage()
        || headerShowsAppliedBadge()
        || isAlreadyAppliedOnPage()
      ) {
        emit({
          status: 'searching',
          jobTitle: naukriState.jobTitle,
          company: naukriState.company,
          reason: 'Apply confirmation detected — counting as success',
        });
        await finalizeNaukriApplication(naukriState);
        return;
      }

      // Chat / question modal still open — keep answering instead of skipping
      if (pageHasRecruiterChatbot() || getNaukriQuestionModal() || findNaukriChatInput(document)) {
        const outcome = await waitForApplyOutcome(
          naukriState.profile,
          45000,
          naukriState.jobTitle,
          naukriState.company,
        );
        if (outcome === 'applied' || outcome === 'already') {
          if (outcome === 'already') {
            markJobProcessed(naukriState, naukriState.currentDetailUrl ?? window.location.href);
            naukriState.counts.skipped++;
            recordSkippedLead(
              naukriState.jobTitle,
              naukriState.company,
              'already applied to this company',
              naukriState.currentDetailUrl ?? normalizeJobUrl(window.location.href),
            );
            emit({
              status: 'skipped',
              jobTitle: naukriState.jobTitle,
              company: naukriState.company,
              reason: 'already applied to this company',
            });
            returnToNaukriSearch(naukriState, naukriState.jobIndex + 1);
          } else {
            await finalizeNaukriApplication(naukriState);
          }
          return;
        }
        if (detectNaukriApplySuccess() || headerShowsAppliedBadge()) {
          await finalizeNaukriApplication(naukriState);
          return;
        }
      }

      emit({
        status: 'searching',
        reason: `Resume idle on ${window.location.pathname} — returning to next job...`,
      });
      if (naukriState.currentDetailUrl || naukriState.phase === 'detail') {
        skipNaukriJobAndAdvance(
          naukriState,
          'Stuck on non-search page — skipped current job',
          naukriState.currentDetailUrl,
        );
      } else {
        returnToNaukriSearch(naukriState, naukriState.jobIndex + 1);
      }
    } catch (err) {
      emit({ status: 'failed', reason: (err as Error).message });
      finish(naukriState.counts);
    } finally {
      automationActive = false;
    }
    return;
  }

  const raw = sessionStorage.getItem(PENDING_KEY);
  if (!raw) return;
  try {
    const pending = JSON.parse(raw) as { runId: string; profile: Profile; criteria: SearchCriteria };
    if (pending.runId && pending.profile && pending.criteria) {
      await startAutomation(pending.profile, pending.criteria, pending.runId);
    }
  } catch {
    // ignore corrupt pending state
  }
}

const NAUKRI_PROFILE_UPDATE_KEY = 'job-autoapply-naukri-profile-update';
const NAUKRI_PROFILE_URL = 'https://www.naukri.com/mnjuser/profile';

interface NaukriProfileUpdateState {
  runId: string;
  updateResume: boolean;
  updateHeadline: boolean;
  resumeFile?: {
    fileName: string;
    mimeType: string;
    base64: string;
    sizeBytes: number;
  };
  headline?: string;
  phase: 'start' | 'resume' | 'headline' | 'done';
  resumeDone?: boolean;
  headlineDone?: boolean;
}

function saveNaukriProfileUpdateState(state: NaukriProfileUpdateState): void {
  sessionStorage.setItem(NAUKRI_PROFILE_UPDATE_KEY, JSON.stringify(state));
}

function loadNaukriProfileUpdateState(): NaukriProfileUpdateState | null {
  const raw = sessionStorage.getItem(NAUKRI_PROFILE_UPDATE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as NaukriProfileUpdateState;
  } catch {
    return null;
  }
}

function clearNaukriProfileUpdateState(): void {
  sessionStorage.removeItem(NAUKRI_PROFILE_UPDATE_KEY);
}

function isNaukriProfilePage(): boolean {
  if (!window.location.hostname.includes('naukri.com')) return false;
  const path = window.location.pathname.toLowerCase();
  return path.includes('/mnjuser/profile')
    || path.includes('/mnjuser/homepage')
    || path.includes('/mnjuser/edit')
    || document.body?.innerText?.toLowerCase().includes('resume headline') === true;
}

function todayResumeDateStamp(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${dd}-${mm}-${yyyy}`; // e.g. 27-07-2026
}

function appendCurrentDateToFileName(fileName: string): string {
  const stamp = todayResumeDateStamp();
  const dot = fileName.lastIndexOf('.');
  const rawBase = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  // Strip any previous date suffix so each upload gets today's stamp on any base name
  const base = rawBase
    .replace(/_\d{4}-\d{2}-\d{2}$/, '')
    .replace(/_\d{2}-\d{2}-\d{4}$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{2}-\d{2}-\d{4}$/, '');
  return `${base}_${stamp}${ext}`;
}

function base64ToFile(resume: {
  fileName: string;
  mimeType: string;
  base64: string;
}, renameWithDate = false): File {
  const binary = atob(resume.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const name = renameWithDate ? appendCurrentDateToFileName(resume.fileName) : resume.fileName;
  return new File([bytes], name, { type: resume.mimeType || 'application/pdf' });
}

function findControlByText(matchers: string[]): HTMLElement | null {
  const needles = matchers.map((m) => m.toLowerCase());
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(
    'button, a, label, span, div[role="button"], input[type="button"], input[type="submit"]',
  ));
  for (const el of nodes) {
    if (!isVisible(el)) continue;
    const text = normalizeText(
      [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' '),
    );
    if (!text) continue;
    if (needles.some((n) => text === n || text.includes(n))) return el;
  }
  return null;
}

function xpathFirst(expression: string): HTMLElement | null {
  try {
    const result = document.evaluate(
      expression,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    );
    const node = result.singleNodeValue;
    return node instanceof HTMLElement ? node : null;
  } catch {
    return null;
  }
}

function isDismissableNaukriModal(text: string): boolean {
  return text.includes('profile photo')
    || text.includes('replace photo')
    || text.includes('power up your profile')
    || text.includes('profile updated successfully')
    || text.includes('explore now')
    || text.includes('ai enhanced profile')
    || text.includes('access to hidden jobs')
    || text.includes('auto-apply on naukri');
}

function clickModalClose(dialog: HTMLElement): boolean {
  const closeCandidates = dialog.querySelectorAll<HTMLElement>(
    'button, a, span, i, em, [role="button"], [aria-label], [class*="close" i]',
  );
  for (const btn of closeCandidates) {
    const label = normalizeText(
      [btn.getAttribute('aria-label'), btn.getAttribute('title'), btn.className?.toString(), btn.textContent]
        .filter(Boolean)
        .join(' '),
    );
    const cls = (btn.className?.toString() || '').toLowerCase();
    if (
      label === 'close'
      || label.includes('close')
      || cls.includes('close')
      || btn.getAttribute('aria-label')?.toLowerCase() === 'close'
    ) {
      forceClick((btn.closest('button, a, [role="button"]') as HTMLElement | null) ?? btn);
      return true;
    }
  }
  // X-only icon buttons with no text
  for (const btn of dialog.querySelectorAll<HTMLElement>('button')) {
    const t = normalizeText(btn.textContent || '');
    if (t === '' || t === 'x' || t === '×') {
      forceClick(btn);
      return true;
    }
  }
  return false;
}

function dismissNaukriOverlayModals(): void {
  // An open recruiter chat must never be closed by overlay cleanup or a stray Escape
  if (isNaukriChatOpen()) return;

  for (const dialog of document.querySelectorAll<HTMLElement>(
    '[role="dialog"], [class*="modal" i], [class*="Modal"], [class*="overlay" i], [class*="popup" i]',
  )) {
    if (!isVisible(dialog) && dialog.offsetParent === null) continue;
    const text = normalizeText(dialog.innerText || '').slice(0, 600);
    if (!isDismissableNaukriModal(text) && !text.includes('profile photo')) continue;
    if (!clickModalClose(dialog)) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

async function dismissNaukriSuccessUpsell(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    dismissNaukriOverlayModals();
    const body = normalizeText(document.body?.innerText || '').slice(0, 2000);
    const stillOpen = body.includes('power up your profile')
      || body.includes('profile updated successfully')
      || body.includes('explore now');
    if (!stillOpen) return;
    await sleep(400);
  }
}

function isResumeFileInput(input: HTMLInputElement): boolean {
  const accept = (input.getAttribute('accept') || '').toLowerCase();
  if (accept.includes('image') || accept.includes('png') || accept.includes('jpg') || accept.includes('jpeg') || accept.includes('gif')) {
    return false;
  }
  if (!accept) return true;
  return accept.includes('pdf') || accept.includes('doc') || accept.includes('rtf') || accept.includes('msword') || accept.includes('.pdf');
}

async function setFileOnInput(input: HTMLInputElement, file: File): Promise<boolean> {
  try {
    input.removeAttribute('disabled');
    input.removeAttribute('readonly');
    const dt = new DataTransfer();
    dt.items.add(file);

    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
    try {
      desc?.set?.call(input, dt.files);
    } catch {
      try {
        input.files = dt.files;
      } catch {
        return false;
      }
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(50);
    return (input.files?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

async function dropFileOnElement(target: HTMLElement, file: File): Promise<boolean> {
  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    const opts: DragEventInit = { bubbles: true, cancelable: true, dataTransfer: dt };
    target.dispatchEvent(new DragEvent('dragenter', opts));
    target.dispatchEvent(new DragEvent('dragover', opts));
    target.dispatchEvent(new DragEvent('drop', opts));
    return true;
  } catch {
    return false;
  }
}

function collectResumeFileInputs(): HTMLInputElement[] {
  const selectors = [
    'input#attachCV',
    'input#attachResume',
    'input[type="file"]#fileUpload',
    'input[type="file"][name*="resume" i]',
    'input[type="file"][id*="resume" i]',
    'input[type="file"][id*="attach" i]',
    'input[type="file"][accept*="pdf"]',
    'input[type="file"][accept*="doc"]',
  ];
  const found: HTMLInputElement[] = [];
  const seen = new Set<HTMLInputElement>();
  for (const sel of selectors) {
    for (const input of document.querySelectorAll<HTMLInputElement>(sel)) {
      if (seen.has(input) || !isResumeFileInput(input)) continue;
      seen.add(input);
      found.push(input);
    }
  }
  // Also any file input near the Update resume / Resume heading
  const anchors = [
    xpathFirst("//*[normalize-space()='Update resume']"),
    xpathFirst("//*[normalize-space()='Resume']"),
  ].filter(Boolean) as HTMLElement[];
  for (const anchor of anchors) {
    let node: HTMLElement | null = anchor;
    for (let depth = 0; depth < 8 && node; depth++) {
      for (const input of node.querySelectorAll<HTMLInputElement>('input[type="file"]')) {
        if (seen.has(input) || !isResumeFileInput(input)) continue;
        seen.add(input);
        found.push(input);
      }
      node = node.parentElement;
    }
  }
  return found;
}

function resumeSectionText(): string {
  const updateBtn = xpathFirst("//*[normalize-space()='Update resume']");
  let node: HTMLElement | null = updateBtn;
  for (let i = 0; i < 10 && node; i++) {
    const t = node.innerText || '';
    if (t.includes('Resume') && (t.includes('.pdf') || t.includes('.doc') || t.includes('Uploaded on'))) {
      return t;
    }
    node = node.parentElement;
  }
  const section = xpathFirst("//*[normalize-space()='Resume']/ancestor::*[contains(@class,'widget') or contains(@class,'card') or self::section][1]");
  return section?.innerText || document.body?.innerText || '';
}

/** Whatever resume filename Naukri is currently showing (any name). */
function readDisplayedResumeFileName(): string | null {
  const text = resumeSectionText() || document.body?.innerText || '';
  const match = text.match(
    /([A-Za-z0-9][A-Za-z0-9._\-() ]{0,180}\.(?:pdf|docx?|rtf))/i,
  );
  return match?.[1]?.trim() || null;
}

function pageShowsResumeName(fileName: string): boolean {
  if (!fileName) return false;
  const body = document.body?.innerText || '';
  if (body.includes(fileName)) return true;
  const displayed = readDisplayedResumeFileName();
  if (displayed && displayed.toLowerCase() === fileName.toLowerCase()) return true;
  return resumeSectionText().includes(fileName);
}

function resumeHasTodaysDateStamp(fileName: string | null | undefined): boolean {
  if (!fileName) return false;
  const stamp = todayResumeDateStamp();
  return fileName.includes(`_${stamp}`) || fileName.includes(`-${stamp}`);
}

/**
 * Success for any uploaded PDF name: exact dated name we sent, OR the on-page
 * resume filename changed and now carries today's DD-MM-YYYY stamp.
 */
function resumeUploadLooksSuccessful(
  expectedDatedName: string,
  nameBeforeUpload: string | null,
): boolean {
  if (pageShowsResumeName(expectedDatedName)) return true;
  const displayed = readDisplayedResumeFileName();
  if (!displayed) return false;
  if (displayed.toLowerCase() === expectedDatedName.toLowerCase()) return true;
  // Different base name is fine — as long as today's stamp is present and it's not the old file
  if (resumeHasTodaysDateStamp(displayed)) {
    if (!nameBeforeUpload) return true;
    if (displayed.toLowerCase() !== nameBeforeUpload.toLowerCase()) return true;
    // Same display name but it already had today's stamp (re-upload of same dated file)
    if (resumeHasTodaysDateStamp(nameBeforeUpload)) return true;
  }
  return false;
}

function resumeUploadBusy(): boolean {
  const text = normalizeText(resumeSectionText());
  if (text.includes('uploading') || text.includes('please wait') || text.includes('processing')) return true;
  const section = xpathFirst("//*[normalize-space()='Update resume']")?.closest('div, section, article');
  if (!section) return false;
  return Boolean(section.querySelector('[class*="loader" i], [class*="spinner" i], [class*="progress" i], .chip'));
}

async function waitForResumeUploadResult(
  expectedDatedName: string,
  nameBeforeUpload: string | null,
  timeoutMs = 45000,
): Promise<'ok' | 'rejected' | 'timeout'> {
  const start = Date.now();
  let seenAt: number | null = resumeUploadLooksSuccessful(expectedDatedName, nameBeforeUpload)
    ? Date.now()
    : null;
  const stableMs = 3500;

  while (Date.now() - start < timeoutMs && !isStopped()) {
    const body = normalizeText(document.body?.innerText || '');
    if (
      body.includes('failed to upload')
      || body.includes('unable to upload')
      || body.includes('upload failed')
      || (body.includes('file size') && body.includes('2 mb') && body.includes('exceed'))
    ) {
      return 'rejected';
    }

    const visible = resumeUploadLooksSuccessful(expectedDatedName, nameBeforeUpload);
    const busy = resumeUploadBusy();

    if (visible && !busy) {
      if (seenAt == null) seenAt = Date.now();
      if (Date.now() - seenAt >= stableMs) {
        await sleep(1000);
        if (isStopped()) {
          return resumeUploadLooksSuccessful(expectedDatedName, nameBeforeUpload) ? 'ok' : 'timeout';
        }
        if (resumeUploadLooksSuccessful(expectedDatedName, nameBeforeUpload) && !resumeUploadBusy()) {
          return 'ok';
        }
        seenAt = resumeUploadLooksSuccessful(expectedDatedName, nameBeforeUpload) ? Date.now() : null;
      }
    } else {
      seenAt = null;
    }
    await sleep(400);
  }

  return resumeUploadLooksSuccessful(expectedDatedName, nameBeforeUpload) ? 'ok' : 'timeout';
}

async function updateNaukriResumeFile(resumeFile: NonNullable<NaukriProfileUpdateState['resumeFile']>): Promise<void> {
  const file = base64ToFile(resumeFile, true);
  const datedName = file.name; // whatever PDF was chosen + _DD-MM-YYYY
  const nameBeforeUpload = readDisplayedResumeFileName();
  const sizeMb = file.size / (1024 * 1024);
  if (sizeMb > 2) {
    throw new Error(`Resume is ${sizeMb.toFixed(1)} MB — Naukri allows up to 2 MB.`);
  }

  emit({ status: 'searching', reason: `Uploading resume as ${datedName}…` });
  if (isStopped()) throw new Error('Stopped by user');

  // Same file already showing with today's stamp — no need to re-upload
  if (pageShowsResumeName(datedName)) {
    emit({ status: 'applied', reason: `Resume already on Naukri as ${datedName}` });
    return;
  }

  // Close photo/upsell popups only — do NOT send Escape during upload (it cancels the attach)
  dismissNaukriOverlayModals();
  await sleep(400);
  if (isStopped()) throw new Error('Stopped by user');

  const updateBtn = xpathFirst("//*[normalize-space()='Update resume']")
    || findControlByText(['update resume']);
  updateBtn?.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  await sleep(200);

  // IMPORTANT: do not click "Update resume" — that opens the OS file picker and clears our programmatic attach.
  const inputs = collectResumeFileInputs();
  let attachedInput: HTMLInputElement | null = null;

  for (const input of inputs) {
    if (isStopped()) throw new Error('Stopped by user');
    if (await setFileOnInput(input, file)) {
      attachedInput = input;
      break;
    }
  }

  // Drop onto the dashed upload zone as a fallback / extra signal for Naukri handlers
  const dropZone = updateBtn?.closest('div')
    ?? xpathFirst("//*[contains(normalize-space(),'Supported Formats')]/ancestor::div[1]");
  if (dropZone) {
    await dropFileOnElement(dropZone, file);
    if (!attachedInput) {
      for (const input of collectResumeFileInputs()) {
        if (await setFileOnInput(input, file)) {
          attachedInput = input;
          break;
        }
      }
    }
  }

  // Naukri sometimes accepts the upload even when input.files checks fail — trust the on-page filename
  if (!attachedInput) {
    await sleep(2000);
    if (isStopped()) throw new Error('Stopped by user');
    if (resumeUploadLooksSuccessful(datedName, nameBeforeUpload)) {
      const shown = readDisplayedResumeFileName() || datedName;
      emit({ status: 'applied', reason: `Resume saved on Naukri as ${shown}` });
      return;
    }
    const settled = await waitForResumeUploadResult(datedName, nameBeforeUpload, 15000);
    if (isStopped()) throw new Error('Stopped by user');
    if (settled === 'ok' || resumeUploadLooksSuccessful(datedName, nameBeforeUpload)) {
      const shown = readDisplayedResumeFileName() || datedName;
      emit({ status: 'applied', reason: `Resume saved on Naukri as ${shown}` });
      return;
    }
    throw new Error(
      `Could not attach ${datedName}. Naukri file input not found or blocked — reload the profile tab and try again.`,
    );
  }

  emit({ status: 'searching', reason: `Resume attached — waiting for Naukri to save ${datedName}…` });

  // Do not dismiss modals / press Escape while upload is in flight
  await sleep(1500);
  if (isStopped()) throw new Error('Stopped by user');
  const result = await waitForResumeUploadResult(datedName, nameBeforeUpload, 45000);
  if (isStopped()) throw new Error('Stopped by user');

  if (result === 'ok' || resumeUploadLooksSuccessful(datedName, nameBeforeUpload)) {
    const shown = readDisplayedResumeFileName() || datedName;
    emit({ status: 'applied', reason: `Resume saved on Naukri as ${shown}` });
    return;
  }
  if (result === 'rejected') {
    throw new Error(`Naukri rejected the resume upload (${datedName}). Check file type/size (max 2 MB).`);
  }

  throw new Error(
    `Resume appeared then was cleared by Naukri (${datedName}). Waited for server save — try a PDF under 2 MB.`,
  );
}

function setNativeFieldValue(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  field.focus();
  const proto = field instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  descriptor?.set?.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
}

async function clickResumeHeadlineEdit(): Promise<boolean> {
  // Naukri structure (from public scripts):
  // //div[@class='widgetHead']//span[text()='Resume headline']/following-sibling::span
  const xpathCandidates = [
    "//div[contains(@class,'widgetHead')]//span[normalize-space()='Resume headline']/following-sibling::span",
    "//div[contains(@class,'widgetHead')]//*[normalize-space()='Resume headline']/following-sibling::*",
    "//span[normalize-space()='Resume headline']/following-sibling::span",
    "//*[normalize-space()='Resume headline']/following-sibling::*[1]",
    "//span[normalize-space()='Resume headline']/parent::*/*[contains(@class,'edit') or contains(@class,'icon')]",
    "//*[normalize-space()='Resume headline']/parent::*//*[contains(@class,'edit') or contains(@class,'pencil') or self::i or self::em or self::svg]",
  ];

  for (const xp of xpathCandidates) {
    const el = xpathFirst(xp);
    if (!el) continue;
    const ctx = normalizeText((el.closest('div, section')?.textContent || '').slice(0, 160));
    if (ctx.includes('profile photo')) continue;
    el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
    forceClick(el);
    await sleep(150);
    return true;
  }

  // Text-node fallback: click last child in the compact header row
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let textNode: Node | null = walker.nextNode();
  while (textNode) {
    if (normalizeText(textNode.textContent || '') === 'resume headline') {
      let row: HTMLElement | null = textNode.parentElement;
      for (let i = 0; i < 6 && row; i++) {
        const children = Array.from(row.children) as HTMLElement[];
        const rowText = normalizeText(row.textContent || '');
        if (children.length >= 2 && rowText.includes('resume headline') && rowText.length < 120) {
          forceClick(children[children.length - 1]);
          return true;
        }
        row = row.parentElement;
      }
      break;
    }
    textNode = walker.nextNode();
  }
  return false;
}

async function waitForHeadlineEditor(timeoutMs = 7000): Promise<HTMLTextAreaElement | HTMLInputElement | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs && !isStopped()) {
    const byId = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(
      '#resumeHeadlineTxt, textarea#resumeHeadlineTxt, input#resumeHeadlineTxt, textarea[name="resumeHeadline"], textarea[id*="resumeHeadline" i]',
    );
    if (byId) return byId;

    for (const el of document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('textarea, input[type="text"]')) {
      if (!isVisible(el) && el.offsetParent === null) continue;
      const max = Number(el.getAttribute('maxlength') || 0);
      const nearby = normalizeText((el.closest('[role="dialog"], [class*="modal"], form, .widget, div')?.textContent || '').slice(0, 400));
      if (nearby.includes('profile photo')) continue;
      if (
        el.id.toLowerCase().includes('resumeheadline')
        || nearby.includes('resume headline')
        || max === 250
        || (max >= 200 && max <= 300)
      ) {
        return el;
      }
    }
    await sleep(250);
  }
  return null;
}

async function updateNaukriResumeHeadline(headline: string): Promise<void> {
  emit({ status: 'searching', reason: 'Updating resume headline…' });
  if (isStopped()) throw new Error('Stopped by user');
  dismissNaukriOverlayModals();
  await sleep(300);
  if (isStopped()) throw new Error('Stopped by user');

  // Prefer the section heading in the main column (not only quick links)
  const sectionTitle = xpathFirst("//div[contains(@class,'widgetHead')]//span[normalize-space()='Resume headline']")
    || xpathFirst("//span[normalize-space()='Resume headline']");
  sectionTitle?.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  await sleep(300);

  const clicked = await clickResumeHeadlineEdit();
  if (!clicked) {
    throw new Error('Could not find the pencil/edit icon next to Resume headline.');
  }

  await sleep(900);
  let field = await waitForHeadlineEditor(7000);
  if (!field) {
    await clickResumeHeadlineEdit();
    field = await waitForHeadlineEditor(5000);
  }
  if (!field) {
    throw new Error('Opened edit but could not find #resumeHeadlineTxt / headline textarea.');
  }

  setNativeFieldValue(field, '');
  await sleep(150);
  setNativeFieldValue(field, headline.slice(0, 250));
  field.value = headline.slice(0, 250);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(400);

  const saveBtn = xpathFirst("//button[normalize-space()='Save']")
    || xpathFirst("//button[contains(normalize-space(),'Save')]")
    || findControlByText(['save']);
  if (!saveBtn) {
    throw new Error('Headline text filled but Save button was not found.');
  }
  forceClick(saveBtn);
  await sleep(2000);
  dismissNaukriOverlayModals();
  emit({ status: 'applied', reason: 'Resume headline saved on Naukri' });
}

async function runNaukriProfileUpdate(state: NaukriProfileUpdateState): Promise<void> {
  if (isStopped()) {
    clearNaukriProfileUpdateState();
    return;
  }
  if (automationActive) return;
  automationActive = true;
  currentRunId = state.runId;
  clearStopFlag();

  let resumeFailedReason: string | null = null;
  let stoppedEarly = false;

  const stopHere = (): boolean => {
    if (!isStopped()) return false;
    stoppedEarly = true;
    clearNaukriProfileUpdateState();
    return true;
  };

  try {
    if (!isNaukriProfilePage()) {
      emit({ status: 'searching', reason: 'Opening Naukri profile page…' });
      saveNaukriProfileUpdateState(state);
      window.location.href = NAUKRI_PROFILE_URL;
      return;
    }

    await sleep(1500);
    if (stopHere()) return;
    dismissNaukriOverlayModals();
    await sleep(300);
    if (stopHere()) return;

    // Headline first, resume last. Saving headline refreshes profile widgets and was
    // wiping a resume upload that had only appeared optimistically in the UI.
    if (state.updateHeadline && !state.headlineDone) {
      if (!state.headline?.trim()) {
        throw new Error('Headline text missing');
      }
      state.phase = 'headline';
      saveNaukriProfileUpdateState(state);
      try {
        await updateNaukriResumeHeadline(state.headline.trim());
        if (stopHere()) return;
        state.headlineDone = true;
      } catch (err) {
        if (isStopped() || (err as Error).message === 'Stopped by user') {
          stopHere();
          return;
        }
        emit({ status: 'failed', reason: `Headline: ${(err as Error).message}` });
        state.headlineDone = false;
      }
      saveNaukriProfileUpdateState(state);
      await sleep(1500);
      if (stopHere()) return;
    }

    if (state.updateResume && !state.resumeDone) {
      if (!state.resumeFile?.base64) {
        throw new Error('Resume file data missing for Naukri upload');
      }
      state.phase = 'resume';
      saveNaukriProfileUpdateState(state);
      try {
        await updateNaukriResumeFile(state.resumeFile);
        if (stopHere()) return;
        state.resumeDone = true;
      } catch (err) {
        if (isStopped() || (err as Error).message === 'Stopped by user') {
          stopHere();
          return;
        }
        // If UI shows our file (any base name) with today's stamp, count as success
        const datedName = state.resumeFile.fileName
          ? appendCurrentDateToFileName(state.resumeFile.fileName)
          : '';
        const shown = readDisplayedResumeFileName();
        if (
          (datedName && pageShowsResumeName(datedName))
          || resumeHasTodaysDateStamp(shown)
        ) {
          state.resumeDone = true;
          emit({ status: 'applied', reason: `Resume on Naukri as ${shown || datedName}` });
        } else {
          resumeFailedReason = (err as Error).message;
          emit({ status: 'failed', reason: `Resume: ${resumeFailedReason}` });
          state.resumeDone = false;
        }
      }
      saveNaukriProfileUpdateState(state);
    }

    if (stopHere()) return;

    state.phase = 'done';
    clearNaukriProfileUpdateState();

    const applied = (state.resumeDone ? 1 : 0) + (state.headlineDone ? 1 : 0);
    const failed = (state.updateResume && !state.resumeDone ? 1 : 0)
      + (state.updateHeadline && !state.headlineDone ? 1 : 0);

    if (resumeFailedReason && state.headlineDone) {
      emit({
        status: 'searching',
        reason: 'Headline updated. Resume step had an issue — verify resume on Naukri.',
      });
    } else if (!state.headlineDone && state.updateHeadline && state.resumeDone) {
      emit({
        status: 'searching',
        reason: 'Resume updated. Headline step had an issue — verify headline on Naukri.',
      });
    } else {
      emit({ status: 'searching', reason: 'Naukri profile update finished' });
    }

    emit({ status: 'searching', reason: 'Closing Naukri popup…' });
    await dismissNaukriSuccessUpsell();
    if (stopHere()) return;

    finish({ applied, skipped: 0, failed });
  } catch (err) {
    clearNaukriProfileUpdateState();
    if (isStopped() || (err as Error).message === 'Stopped by user') {
      stoppedEarly = true;
      return;
    }
    emit({ status: 'failed', reason: (err as Error).message });
    try {
      await dismissNaukriSuccessUpsell();
    } catch {
      // ignore
    }
    finish({
      applied: (state.resumeDone ? 1 : 0) + (state.headlineDone ? 1 : 0),
      skipped: 0,
      failed: 1,
    });
  } finally {
    automationActive = false;
    if (stoppedEarly && currentRunId) {
      // STOP_AUTOMATION may already have finished; avoid duplicate noisy failures
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Only the top frame owns the automation run. Chat typing is done via MAIN-world injection.
  if (!isTopWindow() && message.type !== 'STOP_AUTOMATION') {
    return false;
  }

  if (message.type === 'UPDATE_NAUKRI_PROFILE') {
    clearStopFlag();
    const runId = String(message.runId || crypto.randomUUID());
    currentRunId = runId;
    const state: NaukriProfileUpdateState = {
      runId,
      updateResume: Boolean(message.updateResume),
      updateHeadline: Boolean(message.updateHeadline),
      resumeFile: message.resumeFile,
      headline: typeof message.headline === 'string' ? message.headline : undefined,
      phase: 'start',
    };
    saveNaukriProfileUpdateState(state);
    void runNaukriProfileUpdate(state);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'START_AUTOMATION') {
    const { profile, criteria, runId, platform: msgPlatform, forceFresh } = message;
    if (forceFresh) {
      const freshClaim = `job-autoapply-fresh-${runId}`;
      if (sessionStorage.getItem(freshClaim)) {
        sendResponse({ ok: true, ignored: true });
        return true;
      }
      sessionStorage.setItem(freshClaim, '1');
    }
    const platform = criteria.platform ?? msgPlatform ?? 'linkedin';
    startAutomation(profile, { ...criteria, platform }, runId, Boolean(forceFresh));
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'RESUME_AUTOMATION') {
    resumePendingRun(Boolean(message.force));
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'STOP_AUTOMATION') {
    // Iframes / secondary tabs: halt quietly. Only the top frame of the active run
    // finishes counts; the background emits the single "Stopped by user" log line.
    haltAutomationLocally();
    clearNaukriProfileUpdateState();
    automationActive = false;
    if (!isTopWindow()) {
      sendResponse({ ok: true });
      return true;
    }
    const naukriState = loadNaukriState();
    const linkedInState = loadLinkedInState();
    const profileUpdate = loadNaukriProfileUpdateState();
    const counts = naukriState?.counts ?? linkedInState?.counts ?? {
      applied: (profileUpdate?.resumeDone ? 1 : 0) + (profileUpdate?.headlineDone ? 1 : 0),
      skipped: 0,
      failed: 0,
    };
    // Do not emit interrupted here — background finishStop broadcasts once
    finish(counts);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'MARK_JOB_HANDLED') {
    const naukriUrl = message.payload?.naukriUrl as string | undefined;
    const state = loadNaukriState();
    if (state) {
      const target = naukriUrl || state.currentDetailUrl;
      markJobProcessed(state, target);
      markJobProcessed(state, state.currentDetailUrl);
      if (target) {
        const normalized = normalizeJobUrl(target);
        sessionStorage.setItem(`job-autoapply-skip-recorded-${normalized}`, '1');
        sessionStorage.removeItem(`job-autoapply-bounce-${state.runId}-${normalized}`);
      }
      state.counts.skipped++;
      state.phase = 'list';
      state.currentDetailUrl = undefined;
      state.jobTitle = undefined;
      state.company = undefined;
      state.jobIndex += 1;
      saveNaukriState(state);
      emitLinkedInCounters(state.counts);
    }
    clearNaukriNavIntent();
    sessionStorage.removeItem(`job-autoapply-post-apply-${currentRunId ?? 'none'}`);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'EXTERNAL_TAB_CLOSED') {
    const runId = message.payload?.runId as string | undefined;
    clearExternalPause(runId);
    sessionStorage.removeItem(`job-autoapply-external-pending-${runId || currentRunId || 'none'}`);
    emit({
      status: 'searching',
      reason: 'Returned from company website — continuing with the next job...',
    });
    // Background already navigates back to search and resumes; this is a safety fallback
    setTimeout(() => {
      if (!automationActive && !isStopped() && !isExternalPauseActive()) void resumePendingRun(true);
    }, 5000);
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

function shouldAutoResume(): boolean {
  if (!sessionStorage.getItem(PENDING_KEY) || isStopped()) return false;

  const linkedInState = loadLinkedInState();
  if (linkedInState && window.location.hostname.includes('linkedin.com')) {
    return window.location.href.includes('/jobs');
  }

  const state = loadNaukriState();
  if (!state) return false;
  if (window.location.hostname.includes('naukri.com')) {
    if (state.phase === 'detail') return true;
    if (isNaukriSearchPage() && state.phase === 'list' && state.jobIndex >= 0) return true;
  }
  return false;
}

if (isTopWindow() && (window.location.hostname.includes('linkedin.com') || window.location.hostname.includes('naukri.com'))) {
  if (isStopped()) {
    // Keep stop flag; only drop pending work
    sessionStorage.removeItem(PENDING_KEY);
    sessionStorage.removeItem(EXEC_KEY);
    sessionStorage.removeItem(HANDLED_KEY);
    sessionStorage.removeItem(NAUKRI_PROFILE_UPDATE_KEY);
    automationActive = false;
  } else if (loadNaukriProfileUpdateState() && window.location.hostname.includes('naukri.com')) {
    const pending = loadNaukriProfileUpdateState();
    if (pending) void runNaukriProfileUpdate(pending);
  } else if (shouldAutoResume()) {
    resumePendingRun();
  }
}

export {};
