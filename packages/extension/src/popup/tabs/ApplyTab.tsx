import { useState, useEffect } from 'react';
import {
  validateProfileForPlatform,
  searchCriteriaSchema,
  type SearchCriteria,
} from '@job-autoapply/shared';
import { loadUiPreferences, saveUiPreferences } from '../../lib/storage';
import { useAppStore, defaultSearchCriteria } from '../store';

export function ApplyTab() {
  const {
    profile,
    tosAcknowledged,
    isRunning,
    runMode,
    setActiveTab,
    setRunning,
    setRunMode,
    resetRun,
    setTosAcknowledged,
  } = useAppStore();

  const profileUpdateRunning = isRunning && runMode === 'naukri-profile';

  const [criteria, setCriteria] = useState<SearchCriteria>(defaultSearchCriteria());
  const [errors, setErrors] = useState<string[]>([]);
  const [showTos, setShowTos] = useState(false);
  const [pendingPlatform, setPendingPlatform] = useState<'linkedin' | 'naukri' | null>(null);

  useEffect(() => {
    loadUiPreferences().then((prefs) => {
      setCriteria((c) => ({
        ...c,
        platform: prefs.lastPlatform ?? c.platform,
        jobTitles: prefs.lastJobTitles ?? c.jobTitles,
        location: prefs.lastLocation ?? c.location,
        experienceLevel: prefs.lastExperienceLevel ?? c.experienceLevel,
        datePosted: prefs.lastDatePosted ?? c.datePosted,
        notificationEmail: prefs.lastNotificationEmail ?? c.notificationEmail,
        dailyApplicationCap: prefs.lastDailyCap ?? c.dailyApplicationCap,
      }));
    });
  }, []);

  const update = <K extends keyof SearchCriteria>(key: K, value: SearchCriteria[K]) => {
    setCriteria((c) => ({ ...c, [key]: value }));
  };

  const preflight = (platform: 'linkedin' | 'naukri'): string[] => {
    const errs: string[] = [];
    if (!profile) errs.push('Save your profile first.');
    if (profile) errs.push(...validateProfileForPlatform(profile, platform));
    if (!profile?.resumeFile?.fileName) errs.push('Resume file is required.');
    const parsed = searchCriteriaSchema.safeParse({ ...criteria, platform });
    if (!parsed.success) {
      errs.push(...parsed.error.errors.map((e) => e.message));
    }
    return errs;
  };

  const startRun = async (platform: 'linkedin' | 'naukri') => {
    setErrors([]);
    const errs = preflight(platform);
    if (errs.length) {
      setErrors(errs);
      return;
    }

    if (!tosAcknowledged) {
      setPendingPlatform(platform);
      setShowTos(true);
      return;
    }

    const finalCriteria = { ...criteria, platform };
    await saveUiPreferences({
      lastPlatform: platform,
      lastJobTitles: criteria.jobTitles,
      lastLocation: criteria.location,
      lastExperienceLevel: criteria.experienceLevel,
      lastDatePosted: criteria.datePosted,
      lastNotificationEmail: criteria.notificationEmail,
      lastDailyCap: criteria.dailyApplicationCap,
    });

    resetRun();
    setRunMode('apply');
    setActiveTab('run');

    chrome.runtime.sendMessage(
      { type: 'START_APPLY', profile, criteria: finalCriteria },
      (response) => {
        const runtimeError = chrome.runtime.lastError?.message;
        if (runtimeError) {
          setRunning(false);
          setRunMode('idle');
          setActiveTab('apply');
          setErrors([runtimeError]);
          return;
        }
        if (!response?.ok) {
          setRunning(false);
          setRunMode('idle');
          setActiveTab('apply');
          setErrors([response?.error ?? 'Failed to start. Make sure you are logged into LinkedIn/Naukri.']);
          return;
        }
        chrome.runtime.sendMessage({ type: 'GET_RUN_STATE' }, (state) => {
          if (state?.runId) useAppStore.getState().setRunId(state.runId);
        });
      },
    );
  };

  const acknowledgeAndStart = async () => {
    if (!pendingPlatform) return;
    await chrome.storage.local.set({ tosAcknowledged: true });
    setTosAcknowledged(true);
    setShowTos(false);
    const platform = pendingPlatform;
    setPendingPlatform(null);
    await startRun(platform);
  };

  return (
    <div className="screen space-y-4">
      <div className="section-card">
        <h2 className="text-lg font-semibold">Apply to Jobs</h2>
        <p className="text-xs text-muted mt-1">
          Choose filters, then start a focused run on LinkedIn or Naukri.
        </p>
      </div>

      <p className="hint-card">
        No install needed. Click Start — a LinkedIn/Naukri tab opens and the extension applies automatically.
        Be logged into the platform in Chrome first.
      </p>

      {errors.length > 0 && (
        <div className="alert alert-error space-y-1">
          {errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}

      <div className="section-card space-y-3">
      <div>
        <label>Job Titles / Keywords *</label>
        <input
          value={criteria.jobTitles}
          onChange={(e) => update('jobTitles', e.target.value)}
          placeholder="Product Manager, Associate PM"
        />
      </div>

      <div>
        <label>Location (optional)</label>
        <input
          value={criteria.location ?? ''}
          onChange={(e) => update('location', e.target.value)}
          placeholder="Bangalore, Remote"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label>Experience</label>
          <input
            type="number"
            min={0}
            max={50}
            value={criteria.experienceLevel ?? ''}
            onChange={(e) => update('experienceLevel', e.target.value)}
            placeholder="e.g. 2"
          />
        </div>
        <div>
          <label>Date Posted</label>
          <select
            value={criteria.datePosted}
            onChange={(e) => update('datePosted', e.target.value as SearchCriteria['datePosted'])}
          >
            <option value="Past 24h">Past 24h</option>
            <option value="Past week">Past week</option>
            <option value="Any time">Any time</option>
          </select>
        </div>
        <div>
          <label>Target Applications</label>
          <input
            type="number"
            min={1}
            max={100}
            value={criteria.dailyApplicationCap}
            onChange={(e) => update('dailyApplicationCap', Number(e.target.value))}
          />
        </div>
      </div>
      </div>

      <label className="check-row">
        <input
          type="checkbox"
          checked={criteria.easyApplyOnly}
          onChange={(e) => update('easyApplyOnly', e.target.checked)}
        />
        <span>Easy Apply only (LinkedIn)</span>
      </label>

      <div className="section-card">
        <label>Receiver email for company-site report</label>
        <input
          type="email"
          value={criteria.notificationEmail ?? ''}
          onChange={(e) => update('notificationEmail', e.target.value)}
          placeholder="you@example.com"
        />
        <p className="text-xs text-muted mt-2">
          After a run, skipped / company-site jobs are saved to CSV and emailed here via Brevo
          (configure API key in extension Settings).
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          className="btn-primary flex-1"
          disabled={isRunning}
          onClick={() => startRun('linkedin')}
        >
          Apply via LinkedIn
        </button>
        <button
          className="btn-primary flex-1"
          disabled={isRunning}
          onClick={() => startRun('naukri')}
        >
          Apply via Naukri
        </button>
      </div>

      {showTos && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg p-4 max-w-sm space-y-3">
            <h3 className="font-semibold">Terms of Service Warning</h3>
            <p className="text-xs text-gray-600">
              This automates actions on LinkedIn/Naukri, which is against their Terms of Service
              and may result in account restriction. Use at your own risk.
            </p>
            <div className="flex gap-2">
              <button className="btn-secondary flex-1" onClick={() => setShowTos(false)}>
                Cancel
              </button>
              <button
                className="btn-danger flex-1"
                onClick={acknowledgeAndStart}
              >
                I Understand
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
