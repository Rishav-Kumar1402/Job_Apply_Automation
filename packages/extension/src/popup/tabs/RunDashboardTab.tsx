import { useEffect, useRef } from 'react';
import { type ExternalCompanyLead, useAppStore } from '../store';

function statusClass(status: string): string {
  switch (status) {
    case 'applied': return 'status-applied';
    case 'skipped': return 'status-skipped';
    case 'failed': return 'status-failed';
    default: return 'status-searching';
  }
}

function csvEscape(value: string | undefined): string {
  const safe = value ?? '';
  return `"${safe.replace(/"/g, '""')}"`;
}

function listingUrlLabel(url: string | undefined): string {
  const u = (url || '').toLowerCase();
  if (u.includes('linkedin.com')) return 'LinkedIn URL';
  if (u.includes('naukri.com')) return 'Naukri URL';
  return 'Job URL';
}

function externalLeadsToCsv(leads: ExternalCompanyLead[]): string {
  const statusOf = (lead: ExternalCompanyLead) =>
    lead.skipReason
    ?? (lead.sourceType === 'applied'
      ? 'Applied'
      : lead.sourceType === 'failed'
        ? 'Failed'
      : lead.sourceType === 'company-site'
        ? 'Apply on company site'
        : 'Skipped');
  return [
    ['Company', 'Job Title', 'Status', 'Job Listing URL', 'Company Apply URL', 'Captured At'].map(csvEscape).join(','),
    ...leads.map((lead) => [
      lead.company,
      lead.jobTitle,
      statusOf(lead),
      lead.naukriUrl,
      lead.externalUrl ?? '',
      lead.capturedAt,
    ].map(csvEscape).join(',')),
  ].join('\n');
}

export function RunDashboardTab() {
  const {
    isRunning,
    statusEvents,
    runSummary,
    liveCounters,
    runToast,
    externalLeads,
    tabTitle,
    runId,
    setRunning,
    addStatusEvent,
    setStatusEvents,
    setRunSummary,
    setLiveCounters,
    setRunToast,
    setExternalLeads,
    setTabInfo,
    setRunId,
    resetRun,
    setRunMode,
  } = useAppStore();

  const hydratedRef = useRef(false);
  const toastTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const listener = (message: { type: string; payload?: unknown }) => {
      if (message.type !== 'AUTOMATION_EVENT' || !message.payload) return;
      const payload = message.payload as {
        type: string;
        runId?: string;
        status?: string;
        jobTitle?: string;
        company?: string;
        reason?: string;
        tabTitle?: string;
        tabUrl?: string;
        applied?: number;
        skipped?: number;
        failed?: number;
        toast?: boolean;
        toastTone?: 'info' | 'warning' | 'success' | 'error';
        events?: Parameters<typeof setStatusEvents>[0];
        externalLeads?: ExternalCompanyLead[];
      };

      const currentRunId = useAppStore.getState().runId;
      // RUN_STARTED always carries a new runId — it must never be filtered out as "stale",
      // otherwise the previous run's counters and report stay on screen.
      if (
        payload.type !== 'RUN_STARTED'
        && payload.runId
        && currentRunId
        && payload.runId !== currentRunId
      ) {
        return;
      }

      if (payload.type === 'RUN_STARTED' && payload.runId) {
        // Fresh run — wipe previous counters / report so UI does not retain old numbers
        resetRun();
        setRunId(payload.runId);
        setTabInfo(payload.tabTitle ?? null, payload.tabUrl ?? null);
        setRunMode('apply');
        setRunning(true);
      }

      if (payload.type === 'COUNTERS_UPDATED') {
        setLiveCounters({
          applied: payload.applied ?? 0,
          skipped: payload.skipped ?? 0,
          failed: payload.failed ?? 0,
        });
      }

      if (payload.type === 'AUTO_STOP') {
        setRunning(false);
        setRunMode('idle');
        const summary = {
          applied: payload.applied ?? 0,
          skipped: payload.skipped ?? 0,
          failed: payload.failed ?? 0,
        };
        setRunSummary(summary);
        setLiveCounters(summary);
        const message = payload.reason
          || 'Automation stopped — wait a bit, then try again.';
        setRunToast({
          message,
          tone: payload.toastTone ?? 'warning',
        });
        if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
        toastTimerRef.current = window.setTimeout(() => setRunToast(null), 12000);
        if (payload.reason) {
          addStatusEvent({
            type: 'STATUS_EVENT',
            runId: payload.runId,
            status: 'failed',
            reason: payload.reason,
          } as Parameters<typeof addStatusEvent>[0]);
        }
      }

      if (payload.type === 'STATUS_EVENT') {
        addStatusEvent(payload as Parameters<typeof addStatusEvent>[0]);
        if (payload.status === 'failed' && /rate.?limit|try again|wait 10/i.test(payload.reason || '')) {
          setRunning(false);
          setRunMode('idle');
          setRunToast({
            message: payload.reason || 'Naukri rate limit — try again in 10–15 minutes.',
            tone: 'warning',
          });
          if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
          toastTimerRef.current = window.setTimeout(() => setRunToast(null), 12000);
        }
        if (payload.status === 'searching' || payload.status === 'applied' || payload.status === 'skipped') {
          // Automation still active — keep Stop available
          chrome.runtime.sendMessage({ type: 'GET_RUN_STATE' }, (state) => {
            if (state?.isRunning) {
              setRunning(true);
              if (state.mode === 'naukri-profile') setRunMode('naukri-profile');
              else setRunMode('apply');
            }
          });
        }
        if (payload.tabTitle || payload.tabUrl) {
          setTabInfo(payload.tabTitle ?? null, payload.tabUrl ?? null);
        }
      }

      if (payload.type === 'RUN_SUMMARY') {
        setRunning(false);
        setRunMode('idle');
        const summary = {
          applied: payload.applied ?? 0,
          skipped: payload.skipped ?? 0,
          failed: payload.failed ?? 0,
        };
        setRunSummary(summary);
        setLiveCounters(summary);
        if (payload.externalLeads) setExternalLeads(payload.externalLeads);
      }

      if (payload.type === 'EXTERNAL_LEADS_UPDATED' && payload.externalLeads) {
        setExternalLeads(payload.externalLeads);
      }
    };

    chrome.runtime.onMessage.addListener(listener);

    const hydrate = () => {
      chrome.runtime.sendMessage({ type: 'GET_RUN_STATE' }, (state) => {
        if (chrome.runtime.lastError) return;
        // A different runId means a newer run — drop everything from the old one first
        const knownRunId = useAppStore.getState().runId;
        if (state?.runId && knownRunId && state.runId !== knownRunId) {
          resetRun();
        }
        if (state?.runId) setRunId(state.runId);
        if (state?.isRunning !== undefined) setRunning(Boolean(state.isRunning));
        if (state?.isRunning) {
          if (state.mode === 'naukri-profile') setRunMode('naukri-profile');
          else setRunMode('apply');
        } else if (state?.isRunning === false) {
          setRunMode('idle');
        }
        if (state?.tabTitle) setTabInfo(state.tabTitle, state.tabUrl);
        if (state?.summary) setRunSummary(state.summary);
        else if (state?.isRunning) setRunSummary(null);
        if (state?.liveCounters) setLiveCounters(state.liveCounters);
        if (state?.events) {
          const rid = state.runId as string | undefined;
          const filtered = rid
            ? state.events.filter((e: { runId?: string }) => !e.runId || e.runId === rid)
            : state.events;
          setStatusEvents(filtered);
        }
        if (state?.externalLeads) setExternalLeads(state.externalLeads);
      });
    };

    if (!hydratedRef.current) {
      hydratedRef.current = true;
      hydrate();
    }

    // Keep Stop visible even if a STATUS_EVENT was missed while the panel was closed
    const poll = window.setInterval(hydrate, 2000);

    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      window.clearInterval(poll);
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, [addStatusEvent, resetRun, setExternalLeads, setLiveCounters, setRunSummary, setRunToast, setRunning, setStatusEvents, setTabInfo, setRunId, setRunMode]);

  const countsFromEvents = statusEvents.reduce(
    (acc, e) => {
      if (e.status === 'applied') acc.applied++;
      else if (e.status === 'skipped') acc.skipped++;
      else if (e.status === 'failed') acc.failed++;
      return acc;
    },
    { applied: 0, skipped: 0, failed: 0 },
  );

  // Report rows are deduplicated centrally and are the final authority. Counter messages can
  // arrive out of order after overlapping content-script passes, which made the chips stale.
  const reportCounts = externalLeads.reduce(
    (acc, lead) => {
      if (lead.sourceType === 'applied') acc.applied++;
      else if (lead.sourceType === 'failed') acc.failed++;
      else acc.skipped++;
      return acc;
    },
    { applied: 0, skipped: 0, failed: 0 },
  );
  const fallbackCounts = runSummary ?? liveCounters ?? countsFromEvents;
  const displayCounts = externalLeads.length > 0 ? reportCounts : fallbackCounts;

  const handleViewTab = () => {
    chrome.runtime.sendMessage({ type: 'FOCUS_AUTOMATION_TAB' });
  };

  const handleClear = () => {
    resetRun();
  };

  const handleDownloadCsv = () => {
    chrome.runtime.sendMessage({ type: 'DOWNLOAD_EXTERNAL_LEADS_CSV' }, () => {
      const runtimeError = chrome.runtime.lastError?.message;
      if (!runtimeError) return;

      const blob = new Blob([externalLeadsToCsv(externalLeads)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'company-site-apply-report.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  };

  const handleEmailReport = () => {
    chrome.runtime.sendMessage({ type: 'SEND_EMAIL_REPORT' }, (response) => {
      const runtimeError = chrome.runtime.lastError?.message;
      if (runtimeError) {
        window.alert(runtimeError);
        return;
      }
      if (response?.ok && response.via === 'brevo') {
        window.alert('Report emailed via Brevo (table + CSV).');
        return;
      }
      if (response?.ok && response.via === 'emailjs') {
        window.alert('Report emailed via EmailJS.');
        return;
      }
      if (response?.via === 'mailto') {
        window.alert(response.error || 'Opened your mail app. Configure Brevo in Settings for automatic CSV send.');
        return;
      }
      window.alert(response?.error || 'Could not send email report.');
    });
  };

  return (
    <div className="screen space-y-4">
      {runToast && (
        <div className={`toast toast-${runToast.tone}`} role="status">
          <span className="flex-1">{runToast.message}</span>
          <button
            type="button"
            className="text-xs underline opacity-80"
            onClick={() => setRunToast(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="section-card flex items-center justify-between">
        <h2 className="text-lg font-semibold">Run Dashboard</h2>
        {isRunning && (
          <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded animate-pulse">
            Running
          </span>
        )}
      </div>

      {isRunning && tabTitle && (
        <div className="bg-blue-50 text-blue-800 text-xs p-2 rounded flex items-center justify-between">
          <span>Automation in tab: {tabTitle}</span>
          <button className="text-blue-600 underline" onClick={handleViewTab}>
            View tab
          </button>
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <div className="section-card !p-3">
          <div className="font-bold text-green-700">{displayCounts.applied}</div>
          <div className="text-green-600">Applied</div>
        </div>
        <div className="section-card !p-3">
          <div className="font-bold text-yellow-800">{displayCounts.skipped}</div>
          <div className="text-yellow-700">Skipped</div>
        </div>
        <div className="section-card !p-3">
          <div className="font-bold text-red-700">{displayCounts.failed}</div>
          <div className="text-red-600">Failed</div>
        </div>
      </div>

      {runSummary && !isRunning && (
        <div className="bg-black-100 text-sm p-3 rounded">
          Run complete — {displayCounts.applied} applied, {displayCounts.skipped} skipped,{' '}
          {displayCounts.failed} failed.
        </div>
      )}

      {externalLeads.length > 0 && (
        <div className="section-card space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">Application Report</h3>
              <p className="text-xs text-muted">
                {reportCounts.applied} applied
                {' · '}
                {reportCounts.skipped} company-site / skipped
                {' · '}
                {reportCounts.failed} failed
              </p>
            </div>
            <div className="flex gap-2">
              <button className="btn-secondary py-1.5 px-2 text-xs" onClick={handleDownloadCsv}>
                CSV
              </button>
              <button className="btn-secondary py-1.5 px-2 text-xs" onClick={handleEmailReport}>
                Email
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1 pr-2">Company</th>
                  <th className="py-1 pr-2">Role</th>
                  <th className="py-1 pr-2">Status</th>
                  <th className="py-1">URL</th>
                </tr>
              </thead>
              <tbody>
                {externalLeads.map((lead, index) => (
                  <tr key={`${lead.company}-${lead.jobTitle}-${index}`} className="border-t border-slate-200">
                    <td className="py-2 pr-2 font-medium">{lead.company}</td>
                    <td className="py-2 pr-2">{lead.jobTitle}</td>
                    <td className="py-2 pr-2">
                      {lead.skipReason
                        ?? (lead.sourceType === 'applied'
                          ? 'Applied'
                          : lead.sourceType === 'failed'
                            ? 'Failed'
                          : lead.sourceType === 'company-site'
                            ? 'Apply on company site'
                            : 'Skipped')}
                    </td>
                    <td className="py-2">
                      {lead.externalUrl ? (
                        <a
                          className="text-brand-600 underline break-all"
                          href={lead.externalUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Company URL
                        </a>
                      ) : lead.sourceType === 'company-site' ? (
                        <span className="text-muted">Not captured</span>
                      ) : (
                        <a
                          className="text-brand-600 underline break-all"
                          href={lead.naukriUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {listingUrlLabel(lead.naukriUrl)}
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!isRunning && statusEvents.length > 0 && (
        <button className="text-xs text-gray-500 underline" onClick={handleClear}>
          Clear log
        </button>
      )}

      <div className="section-card space-y-2">
        <h3 className="text-sm font-medium">Live Log</h3>
        {statusEvents.length === 0 && (
          <p className="text-xs text-muted">No events yet. Start a run from the Apply tab.</p>
        )}
        {[...statusEvents].reverse().map((e, i) => (
          <div key={`${e.runId ?? runId}-${e.status}-${e.jobTitle}-${e.reason}-${i}`} className={`text-xs p-2 rounded ${statusClass(e.status)}`}>
            <span className="font-medium capitalize">{e.status}</span>
            {e.jobTitle && ` — ${e.jobTitle}`}
            {e.company && ` @ ${e.company}`}
            {e.reason && <div className="opacity-75 mt-0.5">{e.reason}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
