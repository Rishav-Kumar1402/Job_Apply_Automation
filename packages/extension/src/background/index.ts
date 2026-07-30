import * as cryptoStorage from './cryptoStorage.js';
import type { Profile, SearchCriteria, UiPreferences } from '@job-autoapply/shared';

export interface RunState {
  runId: string | null;
  isRunning: boolean;
  /** Distinguishes job-apply runs from Naukri profile updates. */
  mode?: 'apply' | 'naukri-profile';
  tabId: number | null;
  tabTitle: string | null;
  tabUrl: string | null;
  notificationEmail?: string;
  events: Array<{
    type: string;
    runId?: string;
    status?: string;
    jobTitle?: string;
    company?: string;
    reason?: string;
  }>;
  summary: { applied: number; skipped: number; failed: number } | null;
  /** Live counters from the content script (authoritative while running). */
  liveCounters: { applied: number; skipped: number; failed: number } | null;
  externalLeads: ExternalCompanyLead[];
}

interface ExternalCompanyLead {
  runId?: string;
  jobTitle: string;
  company: string;
  naukriUrl: string;
  externalUrl?: string;
  skipReason?: string;
  sourceType?: 'company-site' | 'skipped' | 'applied';
  capturedAt: string;
}

interface PendingExternalWatch {
  runId: string;
  lead: ExternalCompanyLead;
  returnUrl: string;
  sourceTabId: number;
  candidateUrl?: string;
  createdAt: number;
  /** Lead already reported — the tab now only holds the run parked until capture finishes. */
  captured?: boolean;
  /** Return-to-Naukri already started — prevent double resume. */
  resumed?: boolean;
}

let runState: RunState = {
  runId: null,
  isRunning: false,
  mode: undefined,
  tabId: null,
  tabTitle: null,
  tabUrl: null,
  events: [],
  summary: null,
  liveCounters: null,
  externalLeads: [],
};

const NAUKRI_PROFILE_TAB_CLOSE_DELAY_MS = 10_000;
let naukriProfileTabCloseTimer: ReturnType<typeof setTimeout> | null = null;

function clearNaukriProfileTabCloseTimer(): void {
  if (naukriProfileTabCloseTimer != null) {
    clearTimeout(naukriProfileTabCloseTimer);
    naukriProfileTabCloseTimer = null;
  }
}

function scheduleCloseNaukriProfileTab(tabId: number | null, _runId: string | null): void {
  clearNaukriProfileTabCloseTimer();
  if (tabId == null) return;
  naukriProfileTabCloseTimer = setTimeout(() => {
    naukriProfileTabCloseTimer = null;
    chrome.tabs.remove(tabId).catch(() => {});
  }, NAUKRI_PROFILE_TAB_CLOSE_DELAY_MS);
}

const pendingExternalWatches = new Map<number, PendingExternalWatch>();
const EXTERNAL_CAPTURE_TIMEOUT_MS = 25000;
/** Brief pause so the company URL settles before the automation closes the tab. */
const EXTERNAL_CAPTURE_VISIBLE_MS = 3500;
const CONFIRMATION_WAIT_MS = 6000;
/** Prevents duplicate auto-emails when multiple frames/paths emit RUN_SUMMARY. */
const emailedReportRunIds = new Set<string>();
/** Runs the user explicitly stopped — late content-script events must never revive them. */
const stoppedRunIds = new Set<string>();
const emailJsConfig = {
  serviceId: import.meta.env.VITE_EMAILJS_SERVICE_ID as string | undefined,
  templateId: import.meta.env.VITE_EMAILJS_TEMPLATE_ID as string | undefined,
  publicKey: import.meta.env.VITE_EMAILJS_PUBLIC_KEY as string | undefined,
};

interface BrevoSettings {
  apiKey?: string;
  senderEmail?: string;
  senderName?: string;
  relayUrl?: string;
}

const BREVO_SETTINGS_KEY = 'brevoSettings';

async function getBrevoSettings(): Promise<BrevoSettings> {
  const stored = await chrome.storage.local.get(BREVO_SETTINGS_KEY);
  return (stored[BREVO_SETTINGS_KEY] as BrevoSettings | undefined) ?? {};
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function leadStatusLabel(lead: ExternalCompanyLead): string {
  if (lead.sourceType === 'applied') return lead.skipReason || 'Applied';
  if (lead.sourceType === 'company-site') return lead.skipReason || 'Apply on company site';
  return lead.skipReason || 'Skipped';
}

function leadsToHtmlTable(leads: ExternalCompanyLead[]): string {
  const applied = leads.filter((l) => l.sourceType === 'applied').length;
  const other = leads.length - applied;
  const rows = leads.map((lead, index) => {
    const reason = leadStatusLabel(lead);
    return `<tr>
      <td style="padding:8px;border:1px solid #ddd;">${index + 1}</td>
      <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(lead.company)}</td>
      <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(lead.jobTitle)}</td>
      <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(reason)}</td>
      <td style="padding:8px;border:1px solid #ddd;"><a href="${escapeHtml(lead.naukriUrl)}">${escapeHtml(lead.naukriUrl)}</a></td>
      <td style="padding:8px;border:1px solid #ddd;">${
        lead.externalUrl
          ? `<a href="${escapeHtml(lead.externalUrl)}">${escapeHtml(lead.externalUrl)}</a>`
          : '—'
      }</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;color:#111;">
    <h2>Job Auto-Apply report</h2>
    <p>${applied} applied, ${other} company-site / skipped (${leads.length} total).</p>
    <table style="border-collapse:collapse;width:100%;font-size:13px;">
      <thead>
        <tr style="background:#f3f4f6;">
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">#</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">Company</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">Job Title</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">Status</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">Job Listing URL</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">Company Apply URL</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin-top:16px;color:#555;">CSV attachment included.</p>
  </body></html>`;
}

function isNaukriUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname.includes('naukri.com');
  } catch {
    return url.includes('naukri.com');
  }
}

function isLinkedInUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes('linkedin.com') || host.endsWith('lnkd.in');
  } catch {
    return url.includes('linkedin.com') || url.includes('lnkd.in');
  }
}

function isJobBoardUrl(url: string | undefined): boolean {
  return isNaukriUrl(url) || isLinkedInUrl(url);
}

function isExternalCandidateUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    // Capture real company sites only (follow redirects off Naukri/LinkedIn)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && !host.includes('naukri.com')
      && !host.includes('linkedin.com')
      && !host.endsWith('lnkd.in');
  } catch {
    return false;
  }
}

function externalLeadKey(lead: ExternalCompanyLead): string {
  return `${lead.naukriUrl}|${lead.company}|${lead.jobTitle}`;
}

function findRecentPendingExternal(): PendingExternalWatch | null {
  const now = Date.now();
  const pending = [...pendingExternalWatches.values()]
    .filter((watch) => now - watch.createdAt < 45000 && watch.lead.sourceType === 'company-site')
    .sort((a, b) => b.createdAt - a.createdAt);
  return pending[0] ?? null;
}

function hasSiblingWatch(tabId: number, pending: PendingExternalWatch): boolean {
  const key = externalLeadKey(pending.lead);
  return [...pendingExternalWatches.entries()].some(([id, watch]) =>
    id !== tabId && watch.runId === pending.runId && externalLeadKey(watch.lead) === key,
  );
}

function clearSiblingWatches(pending: PendingExternalWatch): void {
  const key = externalLeadKey(pending.lead);
  for (const [id, watch] of pendingExternalWatches.entries()) {
    if (watch.runId === pending.runId && externalLeadKey(watch.lead) === key) {
      pendingExternalWatches.delete(id);
    }
  }
}

function captureExternalTabWhenStable(tabId: number): void {
  setTimeout(() => {
    const pending = pendingExternalWatches.get(tabId);
    if (!pending) return;
    if (tabId === pending.sourceTabId) return;

    chrome.tabs.get(tabId).then((freshTab) => {
      if (isExternalCandidateUrl(freshTab.url)) pending.candidateUrl = freshTab.url;
      if (isExternalCandidateUrl(pending.candidateUrl)) {
        finalizeExternalCapture(tabId);
      }
    }).catch(() => {
      if (isExternalCandidateUrl(pending.candidateUrl)) finalizeExternalCapture(tabId);
    });
  }, 2500);
}

function attachExternalUrlToPendingTab(tabId: number, url: string | undefined): void {
  if (!isExternalCandidateUrl(url)) return;

  let pending = pendingExternalWatches.get(tabId);
  if (!pending) {
    const recentPending = findRecentPendingExternal();
    if (!recentPending) return;
    // Never treat the Naukri source tab as the company-site tab
    if (tabId === recentPending.sourceTabId) return;
    pending = {
      ...recentPending,
      candidateUrl: url,
    };
    pendingExternalWatches.set(tabId, pending);
  } else if (tabId === pending.sourceTabId) {
    return;
  } else {
    pending.candidateUrl = url;
  }
}

/**
 * Company-site applies stay sequential: while a company tab is open the Naukri run
 * stays paused. The automation closes that tab itself after capture, then returns
 * to the Naukri tab and only then resumes the next job.
 */
const externalPauseTabs = new Map<number, PendingExternalWatch>();

function isExternalPauseActive(): boolean {
  return externalPauseTabs.size > 0;
}

function parkRunForExternalTab(companyTabId: number, pending: PendingExternalWatch): void {
  pending.captured = true;
  externalPauseTabs.set(companyTabId, pending);
  broadcastAutomationEvent({
    type: 'STATUS_EVENT',
    runId: runState.runId,
    status: 'searching',
    jobTitle: pending.lead.jobTitle,
    company: pending.lead.company,
    reason: 'Company website opened — capturing link, then returning to continue...',
  });
}

/** Close the company tab, return to Naukri, then clear the pause so the next job can start. */
function closeCompanyTabAndReturn(companyTabId: number, pending: PendingExternalWatch): void {
  parkRunForExternalTab(companyTabId, pending);

  setTimeout(() => {
    chrome.tabs.remove(companyTabId).then(() => {
      finishExternalAndResume(pending);
    }).catch(() => {
      // Tab already gone — still return to Naukri and continue
      finishExternalAndResume(pending);
    });
  }, EXTERNAL_CAPTURE_VISIBLE_MS);
}

function finishExternalAndResume(pending: PendingExternalWatch): void {
  if (pending.resumed) return;
  pending.resumed = true;

  // Drop every watch for this lead so nothing else can force-resume early
  clearSiblingWatches(pending);
  for (const [id, watch] of externalPauseTabs.entries()) {
    if (watch.runId === pending.runId && externalLeadKey(watch.lead) === externalLeadKey(pending.lead)) {
      externalPauseTabs.delete(id);
    }
  }

  chrome.tabs.sendMessage(pending.sourceTabId, {
    type: 'EXTERNAL_TAB_CLOSED',
    payload: { runId: pending.runId },
  }).catch(() => {});

  returnSourceToSearch(pending);
}

function resumeAutomationTab(tabId: number, delayMs = 800, force = false): void {
  setTimeout(() => {
    if (!runState.isRunning) return;
    // Do not resume while a company-site tab is still being handled
    if (isExternalPauseActive()) return;
    chrome.tabs.sendMessage(tabId, { type: 'RESUME_AUTOMATION', force }).catch(() => {
      if (!runState.isRunning) return;
      setTimeout(() => {
        if (!runState.isRunning || isExternalPauseActive()) return;
        chrome.tabs.sendMessage(tabId, { type: 'RESUME_AUTOMATION', force: true }).catch(() => {});
      }, 1500);
    });
  }, delayMs);
}

function returnSourceToSearch(pending: PendingExternalWatch): void {
  clearSiblingWatches(pending);
  if (!runState.isRunning) return;
  const target = pending.returnUrl;
  if (!target || target.includes('/undefined') || target === 'undefined') {
    broadcastAutomationEvent({
      type: 'STATUS_EVENT',
      runId: runState.runId,
      status: 'searching',
      reason: 'Invalid return URL — forcing resume on current Naukri tab...',
    });
    resumeAutomationTab(pending.sourceTabId, 300, true);
    return;
  }
  chrome.tabs.update(pending.sourceTabId, { url: target, active: true }).then(() => {
    // Naukri SPA often needs a second kick after the loader finishes
    resumeAutomationTab(pending.sourceTabId, 1200, true);
    resumeAutomationTab(pending.sourceTabId, 3500, true);
    resumeAutomationTab(pending.sourceTabId, 7000, true);
  }).catch(() => {});
}

let lastAutomationActivityAt = Date.now();

function noteAutomationActivity(): void {
  lastAutomationActivityAt = Date.now();
}

setInterval(() => {
  if (!runState.isRunning || runState.tabId == null) return;
  // Quiet while a company-site capture is in progress — do not force-resume ahead of it
  if (isExternalPauseActive()) {
    noteAutomationActivity();
    return;
  }
  // 90s — Easy Apply multi-step forms often go quiet between questions
  if (Date.now() - lastAutomationActivityAt < 90000) return;
  noteAutomationActivity();
  broadcastAutomationEvent({
    type: 'STATUS_EVENT',
    runId: runState.runId,
    status: 'searching',
    reason: 'Automation looked stuck — forcing resume...',
  });
  resumeAutomationTab(runState.tabId, 0, true);
}, 15000);

function completeExternalCapture(
  pending: PendingExternalWatch,
  externalUrl: string,
  capturedTabId?: number,
  openPreview = false,
): void {
  if (!pending.captured) {
    addExternalLead({
      ...pending.lead,
      externalUrl,
      capturedAt: new Date().toISOString(),
    });
    pending.captured = true;
  }

  if (capturedTabId && capturedTabId !== pending.sourceTabId) {
    closeCompanyTabAndReturn(capturedTabId, pending);
    return;
  }

  if (openPreview) {
    chrome.tabs.create({ url: externalUrl, active: true }).then((tab) => {
      if (tab.id) {
        const preview: PendingExternalWatch = {
          ...pending,
          candidateUrl: externalUrl,
          createdAt: Date.now(),
          captured: true,
        };
        pendingExternalWatches.set(tab.id, preview);
        closeCompanyTabAndReturn(tab.id, preview);
        return;
      }
      finishExternalAndResume(pending);
    }).catch(() => finishExternalAndResume(pending));
    return;
  }

  finishExternalAndResume(pending);
}

function completeRecentExternalCapture(url: string, tabId?: number): void {
  if (!isExternalCandidateUrl(url)) return;

  // Prefer attaching to an existing company tab and waiting for a stable final URL
  if (tabId != null && tabId >= 0) {
    const pending = pendingExternalWatches.get(tabId) ?? findRecentPendingExternal();
    if (!pending) return;
    if (tabId === pending.sourceTabId) {
      // URL seen on Naukri tab somehow — open it in a real company tab instead
      completeExternalCapture(pending, url, undefined, true);
      return;
    }
    attachExternalUrlToPendingTab(tabId, url);
    captureExternalTabWhenStable(tabId);
    return;
  }

  const pending = findRecentPendingExternal();
  if (!pending) return;
  pending.candidateUrl = url;
  completeExternalCapture(pending, url, undefined, true);
}

function injectWindowOpenHook(tabId: number): Promise<void> {
  return chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const w = window as Window & { __jobAutoApplyOpenHooked?: boolean };
      if (w.__jobAutoApplyOpenHooked) return;
      w.__jobAutoApplyOpenHooked = true;
      const originalOpen = window.open.bind(window);
      window.open = function(url?: string | URL, target?: string, features?: string) {
        const href = url == null ? '' : String(url);
        try {
          window.postMessage({ source: 'job-autoapply', type: 'WINDOW_OPEN', url: href }, '*');
        } catch {
          // ignore
        }
        try {
          const opened = originalOpen(href || 'about:blank', target, features);
          if (opened) return opened;
        } catch {
          // ignore blocked popup
        }
        return {
          closed: false,
          close(this: { closed: boolean }) { this.closed = true; },
          focus() {},
          blur() {},
          location: { href, assign() {}, replace() {}, reload() {}, toString() { return href; } },
          document: { write() {}, writeln() {}, close() {}, open() { return null; } },
          postMessage() {},
          opener: null,
        } as unknown as Window;
      };
    },
  }).then(() => undefined).catch((err: Error) => {
    console.warn('Failed to inject window.open hook:', err.message);
  });
}

function scheduleExternalWatchTimeout(tabId: number): void {
  setTimeout(() => {
    const pending = pendingExternalWatches.get(tabId) ?? externalPauseTabs.get(tabId);
    if (!pending) return;
    // Already closing / returning — leave it alone
    if (pending.captured && externalPauseTabs.has(tabId)) return;

    chrome.tabs.get(tabId).then((tab) => {
      const latestUrl = tab.url;
      if (isExternalCandidateUrl(latestUrl)) pending.candidateUrl = latestUrl;
      if (tabId === pending.sourceTabId) {
        for (const [id, watch] of pendingExternalWatches.entries()) {
          if (id !== tabId && externalLeadKey(watch.lead) === externalLeadKey(pending.lead)) {
            finalizeExternalCapture(id);
            return;
          }
        }
        // No company tab opened in time — resume on Naukri anyway
        finishExternalAndResume(pending);
        return;
      }
      finalizeExternalCapture(tabId);
    }).catch(() => {
      if (tabId === pending.sourceTabId) finishExternalAndResume(pending);
      else finalizeExternalCapture(tabId, true);
    });
  }, EXTERNAL_CAPTURE_TIMEOUT_MS);
}

function broadcastAutomationEvent(payload: Record<string, unknown>): void {
  noteAutomationActivity();
  if (payload.type === 'STATUS_EVENT') {
    const event = payload as RunState['events'][0];
    const key = `${event.runId ?? ''}|${event.status}|${event.jobTitle ?? ''}|${event.company ?? ''}|${event.reason ?? ''}`;
    const looseKey = `${event.status}|${event.jobTitle ?? ''}|${event.company ?? ''}|${event.reason ?? ''}`;
    const isDup = runState.events.some((e) => {
      const full = `${e.runId ?? ''}|${e.status}|${e.jobTitle ?? ''}|${e.company ?? ''}|${e.reason ?? ''}`;
      const loose = `${e.status}|${e.jobTitle ?? ''}|${e.company ?? ''}|${e.reason ?? ''}`;
      return full === key || loose === looseKey;
    });
    // Always collapse repeated "Stopped by user" / identical status lines
    if (!isDup) {
      runState.events.push(event);
    }
  }
  if (payload.type === 'COUNTERS_UPDATED') {
    runState.liveCounters = {
      applied: Number(payload.applied) || 0,
      skipped: Number(payload.skipped) || 0,
      failed: Number(payload.failed) || 0,
    };
  }
  if (payload.type === 'AUTO_STOP') {
    runState.isRunning = false;
    const reason = String(payload.reason || 'Automation stopped.');
    runState.summary = {
      applied: Number(payload.applied) || runState.liveCounters?.applied || 0,
      skipped: Number(payload.skipped) || runState.liveCounters?.skipped || 0,
      failed: Number(payload.failed) || runState.liveCounters?.failed || 0,
    };
    runState.liveCounters = runState.summary;
    // System notification / toaster for rate-limit style stops
    if (payload.toast !== false) {
      try {
        chrome.notifications.create(`job-autoapply-stop-${Date.now()}`, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('public/icons/icon128.png'),
          title: 'Job Auto-Apply stopped',
          message: reason,
          priority: 2,
        });
      } catch {
        // notifications permission may be missing in some loads
      }
    }
  }
  if (payload.type === 'RUN_SUMMARY') {
    runState.isRunning = false;
    runState.summary = {
      applied: (payload.applied as number) ?? 0,
      skipped: (payload.skipped as number) ?? 0,
      failed: (payload.failed as number) ?? 0,
    };
    runState.liveCounters = runState.summary;
    payload.externalLeads = runState.externalLeads;
    maybeOpenEmailReport();
    // Keep Naukri profile tab open after profile updates
  }
  chrome.runtime.sendMessage({ type: 'AUTOMATION_EVENT', payload }).catch(() => {});
}

function addExternalLead(lead: ExternalCompanyLead): void {
  const listingUrl = (lead.naukriUrl || '').trim();
  const normalized: ExternalCompanyLead = {
    ...lead,
    runId: lead.runId ?? runState.runId ?? undefined,
    naukriUrl: listingUrl || lead.naukriUrl || 'Not captured',
    externalUrl: isJobBoardUrl(lead.externalUrl) ? undefined : lead.externalUrl,
    capturedAt: lead.capturedAt || new Date().toISOString(),
  };
  // Deduplicate by listing URL (+ job id) so Mirafra doesn't appear twice with different reasons
  const jobIdMatch = normalized.naukriUrl.match(/(\d{8,})/);
  const jobId = jobIdMatch?.[1] ?? '';
  const sameListing = (item: ExternalCompanyLead) => {
    if (normalized.naukriUrl && item.naukriUrl && normalized.naukriUrl === item.naukriUrl) return true;
    if (jobId && (item.naukriUrl || '').includes(jobId)) return true;
    const sameCompany = (item.company || '').toLowerCase() === (normalized.company || '').toLowerCase();
    const sameTitle = (item.jobTitle || '').toLowerCase() === (normalized.jobTitle || '').toLowerCase();
    return Boolean(sameCompany && sameTitle && normalized.company !== 'Unknown');
  };
  const existingIndex = runState.externalLeads.findIndex(sameListing);
  if (existingIndex >= 0) {
    const prev = runState.externalLeads[existingIndex];
    // Prefer applied > company-site capture > generic skip
    const rank = (t?: string) => (t === 'applied' ? 3 : t === 'company-site' ? 2 : 1);
    const preferIncoming = rank(normalized.sourceType) > rank(prev.sourceType)
      || (normalized.externalUrl && !prev.externalUrl)
      || (!prev.skipReason && normalized.skipReason);
    runState.externalLeads[existingIndex] = {
      ...prev,
      ...(preferIncoming ? normalized : {}),
      naukriUrl: normalized.naukriUrl || prev.naukriUrl,
      externalUrl: normalized.externalUrl ?? prev.externalUrl,
      skipReason: preferIncoming ? (normalized.skipReason ?? prev.skipReason) : (prev.skipReason ?? normalized.skipReason),
      sourceType: rank(normalized.sourceType) >= rank(prev.sourceType)
        ? (normalized.sourceType ?? prev.sourceType)
        : (prev.sourceType ?? normalized.sourceType),
    };
  } else {
    runState.externalLeads.push(normalized);
  }

  chrome.runtime.sendMessage({
    type: 'AUTOMATION_EVENT',
    payload: {
      type: 'EXTERNAL_LEADS_UPDATED',
      runId: runState.runId,
      externalLeads: runState.externalLeads,
    },
  }).catch(() => {});
}

function formatExternalLeadsTable(leads: ExternalCompanyLead[]): string {
  if (leads.length === 0) return 'No applications were captured.';
  const lines = [
    'No | Company | Job Title | Status | Job Listing URL | Company Apply URL',
    '---|---------|-----------|--------|-----------------|------------------',
    ...leads.map((lead, i) => [
      i + 1,
      lead.company,
      lead.jobTitle,
      leadStatusLabel(lead),
      lead.naukriUrl,
      lead.externalUrl || 'Not captured',
    ].join(' | ')),
  ];
  return lines.join('\n');
}

function leadsToCsv(leads: ExternalCompanyLead[]): string {
  const escape = (value: string | undefined) => `"${(value ?? '').replace(/"/g, '""')}"`;
  return [
    ['Company', 'Job Title', 'Status', 'Job Listing URL', 'Company Apply URL', 'Captured At'].map(escape).join(','),
    ...leads.map((lead) => [
      lead.company,
      lead.jobTitle,
      leadStatusLabel(lead),
      lead.naukriUrl,
      lead.externalUrl || '',
      lead.capturedAt,
    ].map(escape).join(',')),
  ].join('\n');
}

async function sendEmailReportViaEmailJs(email: string, subject: string, body: string): Promise<boolean> {
  if (!emailJsConfig.serviceId || !emailJsConfig.templateId || !emailJsConfig.publicKey) return false;

  const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: emailJsConfig.serviceId,
      template_id: emailJsConfig.templateId,
      user_id: emailJsConfig.publicKey,
      template_params: {
        to_email: email,
        subject,
        message: body,
        report_table: body,
      },
    }),
  });

  if (!response.ok) {
    const error = await response.text().catch(() => response.statusText);
    console.warn('EmailJS report send failed:', error);
    return false;
  }
  return true;
}

async function sendEmailReportViaBrevo(
  toEmail: string,
  subject: string,
  leads: ExternalCompanyLead[],
): Promise<{ ok: boolean; error?: string }> {
  const settings = await getBrevoSettings();
  const html = leadsToHtmlTable(leads);
  const csv = leadsToCsv(leads);
  const textBody = [
    'Hi,',
    '',
    'Here is the company-site / skipped jobs report.',
    '',
    formatExternalLeadsTable(leads),
    '',
    `Summary: ${runState.summary?.applied ?? 0} applied, ${runState.summary?.skipped ?? 0} skipped, ${runState.summary?.failed ?? 0} failed.`,
  ].join('\n');

  const relayUrl = (settings.relayUrl || import.meta.env.VITE_BREVO_RELAY_URL as string | undefined)?.trim();
  if (relayUrl) {
    try {
      const response = await fetch(relayUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: toEmail,
          subject,
          html,
          text: textBody,
          csv,
          csvName: 'company-site-apply-report.csv',
        }),
      });
      if (!response.ok) {
        const error = await response.text().catch(() => response.statusText);
        console.warn('Brevo relay send failed:', error);
        return { ok: false, error };
      }
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.warn('Brevo relay send failed:', error);
      return { ok: false, error };
    }
  }

  const apiKey = settings.apiKey?.trim();
  const senderEmail = settings.senderEmail?.trim();
  if (!apiKey || !senderEmail) {
    return { ok: false, error: 'Brevo API key and sender email not configured in Settings' };
  }

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sender: {
          name: settings.senderName?.trim() || 'Job Auto-Apply',
          email: senderEmail,
        },
        to: [{ email: toEmail }],
        subject,
        htmlContent: html,
        textContent: textBody,
        attachment: [{
          name: 'company-site-apply-report.csv',
          content: toBase64Utf8(csv),
        }],
      }),
    });

    if (!response.ok) {
      const error = await response.text().catch(() => response.statusText);
      console.warn('Brevo API send failed:', error);
      return { ok: false, error };
    }
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn('Brevo API send failed:', error);
    return { ok: false, error };
  }
}

async function sendCompanySiteEmailReport(
  toEmail?: string,
  leads?: ExternalCompanyLead[],
): Promise<{ ok: boolean; via?: 'brevo' | 'emailjs' | 'mailto'; error?: string }> {
  const email = (toEmail || runState.notificationEmail || '').trim();
  const reportLeads = leads ?? runState.externalLeads;
  if (!email) return { ok: false, error: 'Receiver email is empty' };
  if (reportLeads.length === 0) return { ok: false, error: 'No report rows to send' };

  const subject = `Job Auto-Apply report (${reportLeads.length})`;
  const appliedCount = reportLeads.filter((l) => l.sourceType === 'applied').length;
  const otherCount = reportLeads.length - appliedCount;
  const textBody = [
    'Hi,',
    '',
    `Here is the auto-apply report from the latest run (${appliedCount} applied, ${otherCount} company-site / skipped).`,
    '',
    formatExternalLeadsTable(reportLeads),
    '',
    `Summary: ${runState.summary?.applied ?? 0} applied, ${runState.summary?.skipped ?? 0} skipped, ${runState.summary?.failed ?? 0} failed.`,
  ].join('\n');

  const brevo = await sendEmailReportViaBrevo(email, subject, reportLeads);
  if (brevo.ok) return { ok: true, via: 'brevo' };

  const emailJsOk = await sendEmailReportViaEmailJs(email, subject, textBody);
  if (emailJsOk) return { ok: true, via: 'emailjs' };

  const url = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(textBody)}`;
  chrome.tabs.create({ url, active: false }).catch(() => {});
  return {
    ok: false,
    via: 'mailto',
    error: brevo.error || 'Opened mailto fallback (configure Brevo in Settings for CSV attachment)',
  };
}

function maybeOpenEmailReport(): void {
  const runId = runState.runId;
  if (!runId) return;
  if (emailedReportRunIds.has(runId)) return;
  if (!runState.notificationEmail?.trim()) return;
  if (runState.externalLeads.length === 0) return;

  // Mark before the async send so concurrent RUN_SUMMARY events cannot race.
  emailedReportRunIds.add(runId);
  void sendCompanySiteEmailReport();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'STORAGE') {
    handleStorageMessage(message.action, message.payload)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'REPORT_AUTOMATION_EVENT') {
    const payload = message.payload as {
      type?: string;
      status?: string;
      runId?: string;
      reason?: string;
    };
    // Ignore stop acks from iframes / secondary tabs — background emits one canonical stop event
    if (
      payload?.type === 'STATUS_EVENT'
      && payload.status === 'interrupted'
      && /stopped by user/i.test(payload.reason || '')
    ) {
      sendResponse({ ok: true, ignored: true });
      return true;
    }
    // If the page is still applying after an unexpected halt, re-show Stop so the user can try
    // again — but never for a run the user explicitly stopped, or Stop appears to do nothing.
    if (
      !runState.isRunning
      && payload?.type === 'STATUS_EVENT'
      && payload.status === 'searching'
      && payload.runId
      && payload.runId === runState.runId
      && !stoppedRunIds.has(payload.runId)
    ) {
      runState.isRunning = true;
    }
    broadcastAutomationEvent(message.payload);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'AUTOMATION_EVENT') {
    broadcastAutomationEvent(message.payload);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'RECORD_EXTERNAL_APPLY_LEAD') {
    const { lead, runId } = message.payload as { lead: ExternalCompanyLead; runId?: string };
    addExternalLead({ ...lead, runId });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'ENSURE_WINDOW_OPEN_HOOK') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'No sender tab for window.open hook.' });
      return true;
    }
    injectWindowOpenHook(tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'CLICK_NAUKRI_APPLY') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'No sender tab for Apply click.' });
      return true;
    }

    const locateAndPrepApply = () => chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      func: () => {
        const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
        const isVisible = (el: HTMLElement) => {
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) return false;
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        };
        const isExternal = (text: string) =>
          text.includes('company site') || text.includes('company website');
        const isApply = (text: string) => {
          if (!text || isExternal(text)) return false;
          return text === 'apply'
            || text === 'apply now'
            || text === 'quick apply'
            || text.startsWith('apply ');
        };

        // Close cookie / promo overlays that steal clicks
        document.querySelectorAll<HTMLElement>(
          '[id*="cookie" i] button, [class*="cookie" i] button, [class*="consent" i] button',
        ).forEach((btn) => {
          const t = normalize(btn.textContent || '');
          if (/accept|got it|ok|agree|allow/.test(t)) {
            try { btn.click(); } catch { /* ignore */ }
          }
        });

        const candidates: HTMLElement[] = [];
        const byId = document.querySelector<HTMLElement>('#apply-button, button#apply-button, #walkin-button');
        if (byId && isVisible(byId) && !isExternal(normalize(byId.textContent || ''))) {
          candidates.push(byId);
        }

        document.querySelectorAll<HTMLElement>('button, a, [role="button"]').forEach((el) => {
          if (!isVisible(el)) return;
          const text = normalize(el.textContent || el.getAttribute('aria-label') || '');
          if (!isApply(text)) return;
          const rect = el.getBoundingClientRect();
          if (rect.top > window.innerHeight * 0.75) return;
          if (rect.width > window.innerWidth * 0.8) return;
          candidates.push(el);
        });

        if (candidates.length === 0) return { clicked: false, reason: 'apply-not-found' };

        candidates.sort((a, b) => {
          const score = (el: HTMLElement) => {
            let s = 0;
            if (el.id === 'apply-button' || el.id === 'walkin-button') s += 1000;
            const cls = (el.className?.toString() || '').toLowerCase();
            if (cls.includes('apply')) s += 100;
            const text = normalize(el.textContent || '');
            if (text === 'apply' || text === 'apply now') s += 50;
            s -= Math.round(el.getBoundingClientRect().top);
            return s;
          };
          return score(b) - score(a);
        });

        const target = candidates[0];

        if (target instanceof HTMLButtonElement) {
          target.disabled = false;
          target.removeAttribute('disabled');
        }
        target.removeAttribute('aria-disabled');
        target.classList.remove('disabled');
        target.scrollIntoView({ block: 'center', behavior: 'instant' });

        const invokeReactClick = (el: HTMLElement): boolean => {
          const tryNode = (node: HTMLElement | null): boolean => {
            if (!node) return false;
            const record = node as unknown as Record<string, unknown>;
            for (const key of Object.keys(record)) {
              if (!key.startsWith('__reactProps$') && !key.startsWith('__reactEventHandlers$')) continue;
              const props = record[key] as { onClick?: (e: unknown) => void } | undefined;
              if (props && typeof props.onClick === 'function') {
                try {
                  props.onClick({
                    preventDefault() {},
                    stopPropagation() {},
                    nativeEvent: new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
                    target: node,
                    currentTarget: node,
                    type: 'click',
                    bubbles: true,
                    cancelable: true,
                    defaultPrevented: false,
                    isTrusted: true,
                  });
                  return true;
                } catch {
                  // continue
                }
              }
            }
            return false;
          };
          let cur: HTMLElement | null = el;
          for (let i = 0; i < 6 && cur; i++) {
            if (tryNode(cur)) return true;
            cur = cur.parentElement;
          }
          return false;
        };

        const rect = target.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        const opts: MouseEventInit = {
          bubbles: true,
          cancelable: true,
          view: window,
          composed: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: 1,
        };
        target.focus();
        const reacted = invokeReactClick(target);
        try {
          target.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }));
          target.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse' }));
        } catch {
          // ignore
        }
        target.dispatchEvent(new MouseEvent('mousedown', opts));
        target.dispatchEvent(new MouseEvent('mouseup', opts));
        target.dispatchEvent(new MouseEvent('click', opts));
        target.click();
        return {
          clicked: true,
          reacted,
          text: normalize(target.textContent || ''),
          x,
          y,
          id: target.id || '',
        };
      },
    });

    const trustedClickAt = async (x: number, y: number) => {
      const target = { tabId };
      try {
        await chrome.debugger.attach(target, '1.3');
      } catch {
        // Already attached or unavailable — try sendCommand anyway
      }
      try {
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x,
          y,
          button: 'none',
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button: 'left',
          clickCount: 1,
          buttons: 1,
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button: 'left',
          clickCount: 1,
          buttons: 1,
        });
        return true;
      } catch {
        return false;
      } finally {
        try {
          await chrome.debugger.detach(target);
        } catch {
          // ignore
        }
      }
    };

    locateAndPrepApply()
      .then(async (results) => {
        const info = results?.[0]?.result as {
          clicked?: boolean;
          x?: number;
          y?: number;
          reacted?: boolean;
        } | undefined;
        if (!info?.clicked || typeof info.x !== 'number' || typeof info.y !== 'number') {
          sendResponse({ ok: true, clicked: false, trusted: false });
          return;
        }
        // Synthetic clicks are often ignored by Naukri — follow with a real CDP click
        const trusted = await trustedClickAt(info.x, info.y);
        sendResponse({ ok: true, clicked: true, trusted, reacted: Boolean(info.reacted) });
      })
      .catch((err: Error) => sendResponse({ ok: false, error: err.message, clicked: false }));
    return true;
  }

  if (message.type === 'CLICK_NAUKRI_OPTION') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'No sender tab for option click.' });
      return true;
    }
    const { preferredLabel, questionHint, ensureChecked } = (message.payload ?? {}) as {
      preferredLabel?: string;
      questionHint?: string;
      ensureChecked?: boolean;
    };

    const locateOption = () => chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      args: [preferredLabel || '', questionHint || '', Boolean(ensureChecked)],
      func: (wantLabel: string, questionHint: string, ensureChecked: boolean) => {
        const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
        const want = normalize(wantLabel);
        const qHint = normalize(questionHint);

        const shortLabel = (el: HTMLElement, input?: HTMLInputElement): string => {
          if (input?.getAttribute('aria-label')) return (input.getAttribute('aria-label') || '').trim();
          const forId = input?.id;
          if (forId) {
            const lab = document.querySelector<HTMLElement>(`label[for="${forId}"]`);
            if (lab) {
              const clone = lab.cloneNode(true) as HTMLElement;
              clone.querySelectorAll('input, svg, button, img').forEach((n) => n.remove());
              const t = (clone.textContent || '').replace(/\s+/g, ' ').trim();
              if (t && t.length <= 60) return t;
            }
          }
          const wrap = input?.closest('label') ?? el.closest('label');
          if (wrap) {
            const clone = wrap.cloneNode(true) as HTMLElement;
            clone.querySelectorAll('input, svg, button, img').forEach((n) => n.remove());
            const t = (clone.textContent || '').replace(/\s+/g, ' ').trim();
            if (t && t.length <= 60) return t;
          }
          const sib = (input ?? el).nextElementSibling;
          if (sib && (sib.textContent || '').trim().length <= 60) {
            return (sib.textContent || '').replace(/\s+/g, ' ').trim();
          }
          const prev = (input ?? el).previousElementSibling;
          if (prev && (prev.textContent || '').trim().length <= 60) {
            return (prev.textContent || '').replace(/\s+/g, ' ').trim();
          }
          return (el.getAttribute('aria-label') || '').trim();
        };

        type Opt = { el: HTMLElement; input?: HTMLInputElement; label: string };
        const opts: Opt[] = [];
        const push = (el: HTMLElement, input?: HTMLInputElement) => {
          const label = shortLabel(el, input);
          if (!label || label.length > 60) return;
          if (/^save$|^submit$|^send$/i.test(label)) return;
          opts.push({ el, input, label });
        };

        const roots: HTMLElement[] = [];
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"], [class*="chatbot" i], [class*="Chatbot"], [class*="NaukriWBot"], [class*="botContainer"], [class*="modal" i], [class*="Modal"], form',
        ).forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 40 || r.height < 40) return;
          roots.push(el);
        });
        if (roots.length === 0) roots.push(document.body);

        for (const root of roots) {
          root.querySelectorAll<HTMLInputElement>('input[type="checkbox"], input[type="radio"]').forEach((input) => {
            const lab = (input.id && document.querySelector<HTMLElement>(`label[for="${input.id}"]`))
              || (input.closest('label') as HTMLElement | null)
              || input;
            push(lab, input);
          });
          root.querySelectorAll<HTMLElement>('[role="radio"], [role="checkbox"]').forEach((el) => push(el));
        }

        if (opts.length === 0) return { clicked: false, reason: 'no-options', count: 0 };

        const score = (o: Opt): number => {
          const l = normalize(o.label);
          let s = 0;
          if (want && (l === want || l.includes(want) || want.includes(l))) s += 100;
          if (/whitefield|mg road|skip this|yes,? i will|will attend|1\s*[-–]\s*2|2\s*[-–]\s*3/i.test(l)) s += 20;
          if (/^(yes|no)\b/.test(l)) s += 30;
          if (/^(>=?\s*|>\s*)?\d+(\.\d+)?\+?$/.test(l)) s += 25;
          if (/resid|relocat|bengaluru|walk|attend|years of experience|fullstack|full stack/i.test(qHint)) {
            if (/whitefield|mg road|skip|yes|no|year|experience|^\d|>=|>/.test(l)) s += 15;
          }
          if (want && /^\d/.test(want) && l === want) s += 50;
          return s;
        };

        opts.sort((a, b) => score(b) - score(a));
        const pick = opts[0];
        const target = pick.el;
        const input = pick.input;

        // Avoid toggle-off: if already checked and ensureChecked, do nothing extra
        if (ensureChecked && input?.checked) {
          return {
            clicked: true,
            label: pick.label,
            checked: true,
            count: opts.length,
            skippedToggle: true,
          };
        }

        if (input) {
          if (!input.checked) {
            input.click();
          }
          if (!input.checked) {
            input.checked = true;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            target.click();
          }
        } else {
          target.click();
        }

        if (input && !input.checked) {
          input.checked = true;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const rect = target.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        return {
          clicked: true,
          label: pick.label,
          x,
          y,
          checked: Boolean(input?.checked ?? true),
          count: opts.length,
        };
      },
    });

    const trustedClickAt = async (x: number, y: number) => {
      const target = { tabId };
      try {
        await chrome.debugger.attach(target, '1.3');
      } catch {
        // already attached
      }
      try {
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1,
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 1,
        });
        return true;
      } catch {
        return false;
      } finally {
        try { await chrome.debugger.detach(target); } catch { /* ignore */ }
      }
    };

    locateOption()
      .then(async (results) => {
        const info = results?.[0]?.result as {
          clicked?: boolean;
          label?: string;
          x?: number;
          y?: number;
          count?: number;
          checked?: boolean;
          skippedToggle?: boolean;
        } | undefined;
        if (!info?.clicked) {
          sendResponse({ ok: true, clicked: false, info });
          return;
        }
        // Do NOT CDP-click again if already checked — a second click toggles checkboxes OFF
        if (info.checked || info.skippedToggle || typeof info.x !== 'number' || typeof info.y !== 'number') {
          sendResponse({
            ok: true,
            clicked: true,
            trusted: false,
            label: info.label,
            count: info.count,
            checked: info.checked,
          });
          return;
        }
        const trusted = await trustedClickAt(info.x, info.y);
        sendResponse({
          ok: true,
          clicked: true,
          trusted,
          label: info.label,
          count: info.count,
          checked: info.checked,
        });
      })
      .catch((err: Error) => sendResponse({ ok: false, error: err.message, clicked: false }));
    return true;
  }

  if (message.type === 'ANSWER_NAUKRI_CHAT') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'No sender tab for chat answer.' });
      return true;
    }
    const { answer } = message.payload as { answer: string; questionHint?: string };
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      args: [answer],
      func: (chatAnswer: string) => {
        const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
        const isVisible = (el: HTMLElement) => {
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) return false;
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        };

        // If radios/checkboxes are showing, NEVER type into chat (was sending CTC / Yes as text)
        const choiceRoots = document.querySelectorAll<HTMLElement>(
          '[role="dialog"], [class*="chatbot" i], [class*="Chatbot"], [class*="NaukriWBot"], [class*="botContainer"], [class*="modal" i]',
        );
        for (const root of Array.from(choiceRoots)) {
          if (!isVisible(root)) continue;
          const radios = root.querySelectorAll('input[type="radio"], [role="radio"]').length;
          const boxes = root.querySelectorAll('input[type="checkbox"]').length;
          if (radios + boxes > 0) {
            return { typed: false, blocked: 'choices-visible', radios, boxes };
          }
        }
        // Also block if any visible radio/checkbox near Save
        const anyChoice = document.querySelectorAll('input[type="radio"], input[type="checkbox"]');
        for (const node of Array.from(anyChoice)) {
          const el = node as HTMLElement;
          const rect = el.getBoundingClientRect();
          if (rect.width >= 1 || rect.height >= 1 || el.offsetParent !== null) {
            const near = el.closest('[role="dialog"], form, [class*="modal"], [class*="chat"]');
            if (near && isVisible(near as HTMLElement)) {
              return { typed: false, blocked: 'choices-visible' };
            }
          }
        }

        // Naukri's job-alert / "send me jobs like this" / profile widgets are not the chat
        const promoRe = /job alert|jobs like this|get job alerts|similar jobs|subscribe|newsletter|search jobs here|upgrade to naukri pro|view (?:&|and) update profile|search appearances|log ?out/i;
        const isPromoWidget = (el: HTMLElement): boolean => {
          if (el.closest('[class*="NaukriWBot" i], [class*="chatbot" i], [class*="botContainer" i]')) return false;
          const own = [
            (el as HTMLInputElement).placeholder,
            el.getAttribute('aria-label'),
            el.getAttribute('name'),
            el.id,
          ].filter(Boolean).join(' ');
          if (promoRe.test(own)) return true;
          const host = el.closest('form, section, aside, [role="dialog"], div') as HTMLElement | null;
          return promoRe.test((host?.innerText || '').replace(/\s+/g, ' ').slice(0, 400));
        };

        const pickInput = (): HTMLElement | null => {
          const nodes = Array.from(document.querySelectorAll<HTMLElement>(
            'input[type="text"], input:not([type]), input[type="search"], textarea, [contenteditable="true"], [contenteditable=""]',
          ));
          for (const el of nodes) {
            if (!isVisible(el)) continue;
            if (isPromoWidget(el)) continue;
            const ph = ((el as HTMLInputElement).placeholder || '').toLowerCase();
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            const dataPh = (el.getAttribute('data-placeholder') || '').toLowerCase();
            if (
              ph.includes('message')
              || ph.includes('type')
              || dataPh.includes('message')
              || dataPh.includes('type')
              || aria.includes('message')
            ) {
              return el;
            }
          }
          for (const container of Array.from(document.querySelectorAll<HTMLElement>(
            '[class*="chatbot"], [class*="Chatbot"], [class*="NaukriWBot"], [class*="botContainer"], [class*="bot"], [role="dialog"], [class*="modal"]',
          ))) {
            if (!isVisible(container)) continue;
            // Skip containers that are option forms
            if (container.querySelector('input[type="radio"], input[type="checkbox"]')) continue;
            if (promoRe.test(container.textContent || '')) continue;
            const text = (container.textContent || '').toLowerCase();
            if (!(
              text.includes('type message')
              || text.includes('recruiter')
              || text.includes('kindly answer')
            )) {
              continue;
            }
            for (const el of Array.from(container.querySelectorAll<HTMLElement>(
              'input[type="text"], input:not([type]), input[type="search"], textarea, [contenteditable="true"]',
            ))) {
              if (!isVisible(el)) continue;
              const type = (el as HTMLInputElement).type;
              if (type === 'file' || type === 'hidden' || type === 'checkbox' || type === 'radio') continue;
              return el;
            }
          }
          return null;
        };

        const setValue = (el: HTMLElement, value: string) => {
          el.focus();
          el.click();
          if (el.getAttribute('contenteditable') != null) {
            el.textContent = value;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
            return;
          }
          const input = el as HTMLInputElement;
          const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(input, value);
          else input.value = value;
          try {
            document.execCommand('selectAll', false);
            document.execCommand('insertText', false, value);
          } catch {
            // ignore
          }
          if (!input.value) {
            if (setter) setter.call(input, value);
            else input.value = value;
          }
          input.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            data: value,
            inputType: 'insertText',
          }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        };

        const clickSave = (from: ParentNode) => {
          const buttons = Array.from(from.querySelectorAll<HTMLElement>('button, [role="button"], a, input[type="button"], input[type="submit"]'));
          let saveBtn: HTMLElement | null = null;
          for (const btn of buttons) {
            if (!isVisible(btn)) continue;
            const text = normalize(btn.textContent || (btn as HTMLInputElement).value || '');
            if (text === 'save' || text === 'send' || text === 'submit' || text === 'next') {
              saveBtn = btn;
              if (text === 'save') break;
            }
          }
          if (!saveBtn) return false;
          if (saveBtn instanceof HTMLButtonElement) {
            saveBtn.disabled = false;
            saveBtn.removeAttribute('disabled');
          }
          saveBtn.removeAttribute('aria-disabled');
          saveBtn.classList.remove('disabled');
          saveBtn.click();
          saveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          return true;
        };

        const input = pickInput();
        if (!input) return { answered: false, reason: 'input-not-found' };
        setValue(input, chatAnswer);

        const scope = input.closest('[class*="chatbot"], [class*="Chatbot"], [class*="NaukriWBot"], [class*="bot"], [role="dialog"], [class*="modal"]')
          ?? input.parentElement?.parentElement
          ?? document;
        const clicked = clickSave(scope);
        if (!clicked) clickSave(document);

        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
        }));
        input.dispatchEvent(new KeyboardEvent('keyup', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
        }));

        return { answered: true, value: (input as HTMLInputElement).value || input.textContent || '' };
      },
    }).then((results) => {
      const answered = (results ?? []).some((r) => Boolean((r.result as { answered?: boolean } | null)?.answered));
      sendResponse({ ok: true, answered });
    }).catch((err: Error) => sendResponse({ ok: false, error: err.message, answered: false }));
    return true;
  }

  if (message.type === 'TRACK_EXTERNAL_APPLY_NAVIGATION') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: 'No sender tab to track external apply navigation.' });
      return true;
    }
    const { lead, runId, returnUrl } = message.payload as {
      lead: ExternalCompanyLead;
      runId: string;
      returnUrl: string;
    };
    pendingExternalWatches.set(tabId, {
      runId,
      lead: { ...lead, runId },
      returnUrl,
      sourceTabId: tabId,
      createdAt: Date.now(),
    });
    injectWindowOpenHook(tabId).finally(() => {
      scheduleExternalWatchTimeout(tabId);
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'EXTERNAL_APPLY_CONFIRMATION_REACHED') {
    const sourceTabId = sender.tab?.id;
    const { returnUrl, runId } = message.payload as { returnUrl: string; runId?: string };
    const pending = (sourceTabId != null ? pendingExternalWatches.get(sourceTabId) : null)
      ?? findRecentPendingExternal();
    if (!pending) {
      if (sourceTabId != null && returnUrl) {
        chrome.tabs.update(sourceTabId, { url: returnUrl }).catch(() => {});
      }
      sendResponse({ ok: true });
      return true;
    }
    if (returnUrl) pending.returnUrl = returnUrl;
    if (runId) pending.runId = runId;

    const findCapturedSibling = (): number | null => {
      const key = externalLeadKey(pending.lead);
      for (const [id, watch] of pendingExternalWatches.entries()) {
        if (externalLeadKey(watch.lead) === key && isExternalCandidateUrl(watch.candidateUrl)) {
          return id;
        }
      }
      return null;
    };

    const capturedId = findCapturedSibling();
    if (capturedId != null) {
      finalizeExternalCapture(capturedId);
      sendResponse({ ok: true });
      return true;
    }

    const started = Date.now();
    const poll = () => {
      const id = findCapturedSibling();
      if (id != null) {
        finalizeExternalCapture(id);
        return;
      }
      if (Date.now() - started < CONFIRMATION_WAIT_MS) {
        setTimeout(poll, 400);
        return;
      }
      // Leave confirmation page even if company URL never arrived
      returnSourceToSearch(pending);
    };
    setTimeout(poll, 400);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'OPEN_EXTERNAL_APPLY_URL') {
    const sourceTabId = sender.tab?.id;
    if (!sourceTabId) {
      sendResponse({ ok: false, error: 'No sender tab to open external apply URL.' });
      return true;
    }
    const { lead, runId, returnUrl, url } = message.payload as {
      lead: ExternalCompanyLead;
      runId: string;
      returnUrl: string;
      url: string;
    };
    const pending: PendingExternalWatch = {
      runId,
      lead: { ...lead, runId },
      returnUrl,
      sourceTabId,
      candidateUrl: isExternalCandidateUrl(url) ? url : undefined,
      createdAt: Date.now(),
    };
    pendingExternalWatches.set(sourceTabId, pending);

    chrome.tabs.create({ url, active: true }).then((tab) => {
      if (!tab.id) return;
      const tabPending: PendingExternalWatch = {
        ...pending,
        candidateUrl: isExternalCandidateUrl(url) ? url : pending.candidateUrl,
      };
      pendingExternalWatches.set(tab.id, tabPending);

      // Follow redirects: Naukri may open an intermediate URL that lands on company site
      const watchRedirects = (attempt: number) => {
        chrome.tabs.get(tab.id!).then((freshTab) => {
          const live = pendingExternalWatches.get(tab.id!);
          if (!live) return;
          if (isExternalCandidateUrl(freshTab.url)) {
            live.candidateUrl = freshTab.url;
            if (freshTab.status === 'complete') {
              captureExternalTabWhenStable(tab.id!);
              return;
            }
          }
          if (attempt < 20) setTimeout(() => watchRedirects(attempt + 1), 500);
        }).catch(() => {});
      };
      setTimeout(() => watchRedirects(0), 300);
      scheduleExternalWatchTimeout(tab.id);
    }).catch((err: Error) => {
      console.warn('Opening external apply URL failed:', err.message);
    });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'DOWNLOAD_EXTERNAL_LEADS_CSV') {
    const csv = leadsToCsv(runState.externalLeads);
    const dataUrl = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
    chrome.downloads.download({
      url: dataUrl,
      filename: 'company-site-apply-report.csv',
      saveAs: false,
    }).then(() => sendResponse({ ok: true }))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'SEND_EMAIL_REPORT') {
    const toEmail = typeof message.payload?.toEmail === 'string'
      ? message.payload.toEmail
      : undefined;
    sendCompanySiteEmailReport(toEmail)
      .then((result) => sendResponse(result))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_BREVO_SETTINGS') {
    getBrevoSettings()
      .then((settings) => sendResponse({
        ok: true,
        settings: {
          ...settings,
          apiKey: settings.apiKey ? '••••••••' : '',
          hasApiKey: Boolean(settings.apiKey?.trim()),
        },
      }))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'SAVE_BREVO_SETTINGS') {
    const incoming = (message.payload ?? {}) as BrevoSettings & { clearApiKey?: boolean };
    getBrevoSettings()
      .then(async (current) => {
        const next: BrevoSettings = {
          senderEmail: incoming.senderEmail?.trim() || current.senderEmail,
          senderName: incoming.senderName?.trim() || current.senderName || 'Job Auto-Apply',
          relayUrl: incoming.relayUrl?.trim() ?? current.relayUrl,
          apiKey: incoming.clearApiKey
            ? undefined
            : (incoming.apiKey?.trim() && !incoming.apiKey.includes('•')
              ? incoming.apiKey.trim()
              : current.apiKey),
        };
        await chrome.storage.local.set({ [BREVO_SETTINGS_KEY]: next });
        sendResponse({ ok: true });
      })
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'TEST_BREVO_EMAIL') {
    const toEmail = typeof message.payload?.toEmail === 'string'
      ? message.payload.toEmail.trim()
      : '';
    if (!toEmail) {
      sendResponse({ ok: false, error: 'Enter a receiver email to test' });
      return true;
    }
    const sampleLeads: ExternalCompanyLead[] = [{
      company: 'Sample Company',
      jobTitle: 'Software Engineer',
      naukriUrl: 'https://www.naukri.com/job-listings-sample',
      skipReason: 'Brevo test',
      sourceType: 'skipped',
      capturedAt: new Date().toISOString(),
    }];
    sendCompanySiteEmailReport(toEmail, sampleLeads)
      .then((result) => sendResponse(result))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'START_APPLY') {
    if (runState.isRunning) {
      sendResponse({ ok: false, error: 'A run is already in progress. Click Stop first.' });
      return true;
    }
    const { profile, criteria } = message as { profile: Profile; criteria: SearchCriteria };
    startAutomation(profile, criteria)
      .then((ok) => sendResponse({ ok }))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'UPDATE_NAUKRI_PROFILE') {
    if (runState.isRunning) {
      sendResponse({ ok: false, error: 'A run is already in progress. Click Stop first.' });
      return true;
    }
    const payload = message.payload as {
      updateResume?: boolean;
      updateHeadline?: boolean;
      useExistingResume?: boolean;
      resumeFile?: Profile['resumeFile'];
      headline?: string;
    };
    startNaukriProfileUpdate(payload)
      .then((runId) => sendResponse({ ok: true, runId }))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'STOP_APPLY') {
    // Broadcast force-stop immediately so content scripts halt even before tab messaging
    void chrome.storage.local.set({ 'job-autoapply-force-stop': Date.now() });
    clearNaukriProfileTabCloseTimer();
    runState.isRunning = false;
    if (runState.runId) stoppedRunIds.add(runState.runId);
    startedTabIds.clear();
    pendingExternalWatches.clear();
    externalPauseTabs.clear();

    const stopInTab = async (tabId: number): Promise<void> => {
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'STOP_AUTOMATION' });
      } catch {
        // content script may be missing; fall through to direct storage write
      }
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: () => {
            try {
              sessionStorage.setItem('job-autoapply-stop', '1');
              sessionStorage.removeItem('job-autoapply-pending-run');
              sessionStorage.removeItem('job-autoapply-exec');
              sessionStorage.removeItem('job-autoapply-handled');
              sessionStorage.removeItem('job-autoapply-naukri-profile-update');
            } catch {
              // ignore
            }
          },
        });
      } catch {
        // tab may not allow scripting
      }
    };

    const finishStop = async () => {
      // Hit the active automation tab first so Stop takes effect immediately
      if (runState.tabId != null) {
        await stopInTab(runState.tabId);
      }
      const tabIds = new Set<number>();
      try {
        const tabs = await chrome.tabs.query({
          url: ['*://*.naukri.com/*', '*://naukri.com/*', '*://*.linkedin.com/*', '*://linkedin.com/*'],
        });
        for (const tab of tabs) {
          if (tab.id != null && tab.id !== runState.tabId) tabIds.add(tab.id);
        }
      } catch {
        // ignore query failures
      }
      await Promise.all([...tabIds].map((id) => stopInTab(id)));
      broadcastAutomationEvent({
        type: 'STATUS_EVENT',
        runId: runState.runId,
        status: 'interrupted',
        reason: 'Stopped by user',
      });
      broadcastAutomationEvent({
        type: 'RUN_SUMMARY',
        runId: runState.runId,
        applied: runState.summary?.applied ?? runState.events.filter((e) => e.status === 'applied').length,
        skipped: runState.summary?.skipped ?? runState.events.filter((e) => e.status === 'skipped').length,
        failed: runState.summary?.failed ?? runState.events.filter((e) => e.status === 'failed').length,
      });
      sendResponse({ ok: true });
    };

    finishStop().catch(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'GET_RUN_STATE') {
    sendResponse(runState);
    return true;
  }

  if (message.type === 'FOCUS_AUTOMATION_TAB') {
    if (runState.tabId) {
      chrome.tabs.update(runState.tabId, { active: true });
    }
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

/** Lock encrypted storage when the last popup/options UI closes. */
let uiSessionPorts = 0;
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ui-session') return;
  uiSessionPorts += 1;
  port.onDisconnect.addListener(() => {
    uiSessionPorts = Math.max(0, uiSessionPorts - 1);
    if (uiSessionPorts === 0) {
      void cryptoStorage.lockStorage();
    }
  });
});

let startedTabIds = new Set<number>();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const visibleUrl = changeInfo.url ?? tab.url;
  const pendingExternal = pendingExternalWatches.get(tabId);
  const isAutomationSource = runState.tabId === tabId
    || (pendingExternal != null && pendingExternal.sourceTabId === tabId);

  // Source tab left LinkedIn/Naukri for a company site (same-tab offsite Apply)
  if (
    pendingExternal
    && tabId === pendingExternal.sourceTabId
    && isExternalCandidateUrl(visibleUrl)
  ) {
    pendingExternal.candidateUrl = visibleUrl;
    completeExternalCapture(pendingExternal, visibleUrl, undefined, false);
    return;
  }

  // Capture company URLs only on non-job-board tabs
  if (!isJobBoardUrl(visibleUrl) && !isAutomationSource) {
    attachExternalUrlToPendingTab(tabId, visibleUrl);
  }

  if (
    pendingExternal
    && changeInfo.status === 'complete'
    && tabId !== pendingExternal.sourceTabId
    && !isJobBoardUrl(visibleUrl)
  ) {
    if (pendingExternal.candidateUrl || isExternalCandidateUrl(visibleUrl)) {
      if (isExternalCandidateUrl(visibleUrl)) pendingExternal.candidateUrl = visibleUrl;
      captureExternalTabWhenStable(tabId);
    }
    return;
  }

  if (changeInfo.status !== 'complete') return;
  if (!runState.isRunning || runState.tabId !== tabId) return;

  // Always resume the automation tab — never block on leftover external watches
  resumeAutomationTab(tabId, 700, true);
  resumeAutomationTab(tabId, 2500, true);
});

function handleExternalNavigation(details: chrome.webNavigation.WebNavigationFramedCallbackDetails): void {
  if (details.frameId !== 0) return;
  if (isJobBoardUrl(details.url)) return;
  const pending = pendingExternalWatches.get(details.tabId);
  if (pending && details.tabId === pending.sourceTabId) {
    if (isExternalCandidateUrl(details.url)) {
      pending.candidateUrl = details.url;
      completeExternalCapture(pending, details.url, undefined, false);
    }
    return;
  }
  attachExternalUrlToPendingTab(details.tabId, details.url);
}

chrome.webNavigation.onBeforeNavigate.addListener(handleExternalNavigation);
chrome.webNavigation.onCommitted.addListener(handleExternalNavigation);
chrome.webNavigation.onCompleted.addListener((details) => {
  handleExternalNavigation(details);
  const pending = pendingExternalWatches.get(details.tabId);
  if (!pending || details.tabId === pending.sourceTabId) return;
  if (pending.candidateUrl || isExternalCandidateUrl(details.url)) {
    if (isExternalCandidateUrl(details.url)) pending.candidateUrl = details.url;
    captureExternalTabWhenStable(details.tabId);
  }
});

function handleExternalWebRequest(
  details: chrome.webRequest.WebRequestDetails | chrome.webRequest.WebResponseHeadersDetails,
): void {
  if (details.type !== 'main_frame') return;
  if (!isExternalCandidateUrl(details.url)) return;
  const pending = pendingExternalWatches.get(details.tabId) ?? findRecentPendingExternal();
  if (pending && details.tabId === pending.sourceTabId) {
    // Company URL requested from Naukri tab context — open/track via helper
    completeRecentExternalCapture(details.url, details.tabId);
    return;
  }
  attachExternalUrlToPendingTab(details.tabId, details.url);
  if (details.tabId >= 0) captureExternalTabWhenStable(details.tabId);
}

chrome.webRequest.onBeforeRequest.addListener(
  handleExternalWebRequest,
  { urls: ['<all_urls>'], types: ['main_frame'] },
);

chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    if (details.type !== 'main_frame') return;
    const redirectUrl = details.redirectUrl;
    if (!isExternalCandidateUrl(redirectUrl)) return;
    const pending = pendingExternalWatches.get(details.tabId) ?? findRecentPendingExternal();
    if (!pending) return;
    if (details.tabId === pending.sourceTabId) {
      pending.candidateUrl = redirectUrl;
      completeExternalCapture(pending, redirectUrl, undefined, false);
      return;
    }
    attachExternalUrlToPendingTab(details.tabId, redirectUrl);
    if (details.tabId >= 0) captureExternalTabWhenStable(details.tabId);
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
);

chrome.tabs.onCreated.addListener((tab) => {
  if (!tab.id) return;

  let openerPending = tab.openerTabId != null
    ? pendingExternalWatches.get(tab.openerTabId)
    : undefined;
  if (!openerPending) {
    const recent = findRecentPendingExternal();
    if (recent && Date.now() - recent.createdAt < 20000) openerPending = recent;
  }
  if (!openerPending) return;

  const pending: PendingExternalWatch = {
    ...openerPending,
    sourceTabId: openerPending.sourceTabId,
  };
  if (isExternalCandidateUrl(tab.url)) pending.candidateUrl = tab.url;
  pendingExternalWatches.set(tab.id, pending);
  scheduleExternalWatchTimeout(tab.id);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  externalPauseTabs.delete(tabId);

  const pending = pendingExternalWatches.get(tabId);
  if (!pending) return;
  if (tabId === pending.sourceTabId) {
    pendingExternalWatches.delete(tabId);
    externalPauseTabs.clear();
    return;
  }
  // Company tab closed — bookkeeping only. closeCompanyTabAndReturn / finishExternalAndResume
  // owns returning to Naukri and resuming so we never advance while the tab is still open.
  pendingExternalWatches.delete(tabId);
  if (!pending.captured && isExternalCandidateUrl(pending.candidateUrl)) {
    addExternalLead({
      ...pending.lead,
      externalUrl: pending.candidateUrl,
      capturedAt: new Date().toISOString(),
    });
    pending.captured = true;
  }
});

function finalizeExternalCapture(capturedTabId: number, tabClosed = false): void {
  const pending = pendingExternalWatches.get(capturedTabId) ?? externalPauseTabs.get(capturedTabId);
  if (!pending) return;

  const externalUrl = isExternalCandidateUrl(pending.candidateUrl) ? pending.candidateUrl : undefined;
  if (!externalUrl && !tabClosed && hasSiblingWatch(capturedTabId, pending)) {
    if (capturedTabId === pending.sourceTabId) {
      pendingExternalWatches.delete(capturedTabId);
    }
    return;
  }

  if (!pending.captured) {
    addExternalLead({
      ...pending.lead,
      externalUrl,
      capturedAt: new Date().toISOString(),
    });
    pending.captured = true;
  }

  if (capturedTabId !== pending.sourceTabId && !tabClosed) {
    // Automation closes the company tab, then returns to Naukri and resumes
    closeCompanyTabAndReturn(capturedTabId, pending);
    return;
  }

  finishExternalAndResume(pending);
}

async function startNaukriProfileUpdate(payload: {
  updateResume?: boolean;
  updateHeadline?: boolean;
  useExistingResume?: boolean;
  resumeFile?: Profile['resumeFile'];
  headline?: string;
}): Promise<string> {
  const updateResume = Boolean(payload.updateResume);
  const updateHeadline = Boolean(payload.updateHeadline);
  if (!updateResume && !updateHeadline) {
    throw new Error('Select at least resume or headline to update');
  }
  if (updateResume && !payload.resumeFile?.base64) {
    throw new Error('Resume file is missing');
  }
  if (updateHeadline && !payload.headline?.trim()) {
    throw new Error('Headline text is required');
  }

  const runId = crypto.randomUUID();
  const profileUrl = 'https://www.naukri.com/mnjuser/profile';

  clearNaukriProfileTabCloseTimer();
  await chrome.storage.local.remove('job-autoapply-force-stop');
  runState = {
    runId,
    isRunning: true,
    mode: 'naukri-profile',
    tabId: null,
    tabTitle: 'Naukri profile',
    tabUrl: profileUrl,
    events: [],
    summary: null,
    liveCounters: null,
    externalLeads: [],
  };
  emailedReportRunIds.clear();

  const tab = await chrome.tabs.create({ url: profileUrl, active: true });
  if (!tab.id) throw new Error('Could not open Naukri profile tab');

  runState.tabId = tab.id;
  runState.tabTitle = tab.title ?? 'Naukri profile';
  runState.tabUrl = profileUrl;

  broadcastAutomationEvent({
    type: 'RUN_STARTED',
    runId,
    tabTitle: runState.tabTitle,
    tabUrl: profileUrl,
  });
  broadcastAutomationEvent({
    type: 'STATUS_EVENT',
    runId,
    status: 'searching',
    reason: 'Opened Naukri profile — applying selected updates…',
  });

  await waitForTabLoad(tab.id);
  await sleep(3500);

  const startPayload = {
    type: 'UPDATE_NAUKRI_PROFILE',
    runId,
    updateResume,
    updateHeadline,
    resumeFile: payload.resumeFile,
    headline: payload.headline?.trim(),
  };

  try {
    await chrome.tabs.sendMessage(tab.id, startPayload);
  } catch {
    await sleep(2000);
    try {
      await chrome.tabs.sendMessage(tab.id, startPayload);
    } catch {
      runState.isRunning = false;
      broadcastAutomationEvent({
        type: 'STATUS_EVENT',
        runId,
        status: 'failed',
        reason: 'Could not start profile update on the tab. Reload the extension and try again.',
      });
      broadcastAutomationEvent({
        type: 'RUN_SUMMARY',
        runId,
        applied: 0,
        skipped: 0,
        failed: 1,
      });
      throw new Error('Could not start profile update on the Naukri tab');
    }
  }

  return runId;
}

async function startAutomation(profile: Profile, criteria: SearchCriteria): Promise<boolean> {
  const runId = crypto.randomUUID();
  const platform = criteria.platform;
  const searchUrl = platform === 'linkedin'
    ? buildLinkedInUrl(criteria)
    : buildNaukriUrl(criteria);

  clearNaukriProfileTabCloseTimer();
  await chrome.storage.local.remove('job-autoapply-force-stop');
  runState = {
    runId,
    isRunning: true,
    mode: 'apply',
    tabId: null,
    tabTitle: null,
    tabUrl: searchUrl,
    notificationEmail: criteria.notificationEmail || undefined,
    events: [],
    summary: null,
    liveCounters: null,
    externalLeads: [],
  };
  emailedReportRunIds.clear();
  stoppedRunIds.clear();

  const tab = await chrome.tabs.create({ url: searchUrl, active: true });
  if (!tab.id) return false;

  runState.tabId = tab.id;
  runState.tabTitle = tab.title ?? platform;
  runState.tabUrl = searchUrl;

  broadcastAutomationEvent({
    type: 'RUN_STARTED',
    runId,
    tabTitle: runState.tabTitle,
    tabUrl: searchUrl,
  });

  // Ensure UI report/counters clear even if a hydrate raced before RUN_STARTED
  broadcastAutomationEvent({
    type: 'EXTERNAL_LEADS_UPDATED',
    runId,
    externalLeads: [],
  });

  broadcastAutomationEvent({
    type: 'STATUS_EVENT',
    runId,
    status: 'searching',
    reason: `Opened ${platform} — automation runs in this tab`,
  });

  // Wait for page + content script, then start (longer wait for Naukri SPA)
  await waitForTabLoad(tab.id);
  await sleep(platform === 'naukri' ? 5000 : 2500);

  if (startedTabIds.has(tab.id)) return true;
  startedTabIds.add(tab.id);

  const startPayload = {
    type: 'START_AUTOMATION',
    runId,
    profile,
    criteria: { ...criteria, platform },
    platform,
    forceFresh: true,
  };

  try {
    await chrome.tabs.sendMessage(tab.id, startPayload);
    return true;
  } catch {
    await sleep(2000);
    try {
      await chrome.tabs.sendMessage(tab.id, startPayload);
      return true;
    } catch {
      startedTabIds.delete(tab.id);
      runState.isRunning = false;
      broadcastAutomationEvent({
        type: 'STATUS_EVENT',
        runId,
        status: 'failed',
        reason: 'Could not start automation on the tab. Reload the extension and try again.',
      });
      return false;
    }
  }
}

function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function buildLinkedInUrl(criteria: SearchCriteria): string {
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
  for (const [name, gid] of Object.entries(NAUKRI_CITY_TYPE_GID)) {
    if (primary.includes(name) || name.includes(primary)) return gid;
  }
  return undefined;
}

/** Naukri applies location/experience/freshness only on slug search URLs, not on /jobs?k=... */
function buildNaukriUrl(criteria: SearchCriteria): string {
  const params = new URLSearchParams();
  const jobTitles = String(criteria.jobTitles ?? '').trim();
  if (jobTitles && jobTitles !== 'undefined' && jobTitles !== 'null') {
    params.set('k', jobTitles);
  }

  const primaryLocation = String(criteria.location ?? '').split(',')[0].trim();
  const cityGid = resolveNaukriCityTypeGid(criteria.location);
  if (cityGid) {
    params.set('cityTypeGid', cityGid);
  } else if (primaryLocation && primaryLocation !== 'undefined') {
    params.set('l', primaryLocation);
  }

  const years = Number(criteria.experienceLevel);
  if (criteria.experienceLevel != null && criteria.experienceLevel !== '' && Number.isFinite(years)) {
    params.set('experience', String(Math.min(Math.max(Math.round(years), 0), 30)));
  }

  if (criteria.datePosted === 'Past 24h') params.set('jobAge', '1');
  if (criteria.datePosted === 'Past week') params.set('jobAge', '7');

  const titleSlug = toNaukriSlug(jobTitles.split(',')[0] ?? '');
  const locationSlug = toNaukriSlug(primaryLocation);
  let path = 'jobs';
  if (titleSlug && locationSlug) path = `${titleSlug}-jobs-in-${locationSlug}`;
  else if (titleSlug) path = `${titleSlug}-jobs`;
  else if (locationSlug) path = `jobs-in-${locationSlug}`;
  if (!path || path === 'undefined' || path.includes('undefined')) {
    path = titleSlug ? `${titleSlug}-jobs` : 'jobs';
  }

  return `https://www.naukri.com/${path}?${params.toString()}`;
}

async function handleStorageMessage(action: string, payload?: unknown): Promise<unknown> {
  switch (action) {
    case 'status':
      return cryptoStorage.getStorageStatus();
    case 'setup': {
      const { passphrase } = payload as { passphrase: string };
      await cryptoStorage.setupEncryption(passphrase);
      return true;
    }
    case 'unlock': {
      const { passphrase } = payload as { passphrase: string };
      return cryptoStorage.unlockWithPassphrase(passphrase);
    }
    case 'lock':
      await cryptoStorage.lockStorage();
      return true;
    case 'saveProfile': {
      const { profile } = payload as { profile: Profile };
      await cryptoStorage.saveProfile(profile);
      return true;
    }
    case 'loadProfile':
      return cryptoStorage.loadProfile();
    case 'clear':
      await cryptoStorage.clearAllData();
      return true;
    case 'saveUiPreferences': {
      const { prefs } = payload as { prefs: UiPreferences };
      await cryptoStorage.saveUiPreferences(prefs);
      return true;
    }
    case 'loadUiPreferences':
      return cryptoStorage.loadUiPreferences();
    case 'isTosAcknowledged':
      return cryptoStorage.isTosAcknowledged();
    case 'acknowledgeTos':
      await cryptoStorage.acknowledgeTos();
      return true;
    default:
      throw new Error(`Unknown storage action: ${action}`);
  }
}

export {};
