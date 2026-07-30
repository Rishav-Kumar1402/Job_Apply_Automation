import { useEffect, useRef, useState } from 'react';
import type { Profile, ResumeFile } from '@job-autoapply/shared';
import { readResumeFile, saveProfile } from '../../lib/storage';
import { ResumeUpload } from './ResumeUpload';
import { useAppStore } from '../store';

type ResumeSource = 'existing' | 'new';

interface NaukriProfileUpdatePanelProps {
  profile: Profile | null;
  onProfileUpdated?: (profile: Profile) => void;
}

export function NaukriProfileUpdatePanel({ profile, onProfileUpdated }: NaukriProfileUpdatePanelProps) {
  const {
    isRunning,
    runMode,
    runId,
    setRunMode,
    setRunId,
    setRunning,
    addStatusEvent,
  } = useAppStore();
  const profileRunActive = isRunning && runMode === 'naukri-profile';
  const applyRunActive = isRunning && runMode === 'apply';

  const [open, setOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [updateResume, setUpdateResume] = useState(true);
  const [updateHeadline, setUpdateHeadline] = useState(true);
  const [resumeSource, setResumeSource] = useState<ResumeSource>('existing');
  const [newResume, setNewResume] = useState<ResumeFile | null>(null);
  const [headline, setHeadline] = useState(profile?.naukriResumeHeadline ?? '');
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [localLogs, setLocalLogs] = useState<Array<{ status: string; reason: string }>>([]);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** When false, ignore late automation events after Stop (avoids stale closure continuing the run in the UI). */
  const acceptEventsRef = useRef(false);
  const runIdRef = useRef(runId);
  runIdRef.current = runId;

  useEffect(() => {
    setHeadline(profile?.naukriResumeHeadline ?? '');
  }, [profile?.naukriResumeHeadline]);

  useEffect(() => () => {
    if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
  }, []);

  useEffect(() => {
    const listener = (message: { type: string; payload?: Record<string, unknown> }) => {
      if (message.type !== 'AUTOMATION_EVENT' || !message.payload) return;
      if (!acceptEventsRef.current) return;
      const payload = message.payload as {
        type?: string;
        runId?: string;
        status?: string;
        reason?: string;
        applied?: number;
        skipped?: number;
        failed?: number;
      };
      if (runIdRef.current && payload.runId && payload.runId !== runIdRef.current) return;

      if (payload.type === 'STATUS_EVENT' && payload.status) {
        // After local Stop, ignore everything except the interrupted ack
        if (payload.status === 'interrupted') {
          acceptEventsRef.current = false;
        }
        const reason = payload.reason || payload.status;
        setLocalLogs((prev) => {
          const next = [...prev, { status: payload.status!, reason }];
          return next.slice(-12);
        });
        setStatusOpen(true);
        addStatusEvent(payload as Parameters<typeof addStatusEvent>[0]);
      }

      if (payload.type === 'RUN_SUMMARY') {
        acceptEventsRef.current = false;
        const failed = payload.failed ?? 0;
        const applied = payload.applied ?? 0;
        setDoneMessage(
          failed > 0
            ? `Finished with errors (${applied} ok, ${failed} failed). Check status above.`
            : `Naukri profile update finished (${applied} update${applied === 1 ? '' : 's'}).`,
        );
        setRunning(false);
        setRunMode('idle');
        setStarting(false);
        setStatusOpen(false);

        if (failed === 0) {
          if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
          collapseTimerRef.current = setTimeout(() => {
            setOpen(false);
            collapseTimerRef.current = null;
          }, 10_000);
        }
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [addStatusEvent, setRunning, setRunMode]);

  const handleNewResume = async (file: File) => {
    try {
      const resumeFile = await readResumeFile(file);
      setNewResume(resumeFile);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read resume file');
    }
  };

  const busy = starting || profileRunActive;
  const lockedByApply = applyRunActive;

  const handleStart = async () => {
    setError(null);
    setDoneMessage(null);
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
    if (isRunning) {
      setError(runMode === 'apply'
        ? 'Stop job apply first, then update Naukri profile.'
        : 'A Naukri profile update is already running.');
      return;
    }
    if (!updateResume && !updateHeadline) {
      setError('Choose at least one: resume or headline.');
      return;
    }
    if (updateResume && resumeSource === 'existing' && !profile?.resumeFile?.fileName) {
      setError('No existing resume in Profile. Upload one first or choose a new file.');
      return;
    }
    if (updateResume && resumeSource === 'new' && !newResume?.fileName) {
      setError('Select a new resume file to upload.');
      return;
    }
    if (updateHeadline && !headline.trim()) {
      setError('Enter a resume headline (or uncheck headline update).');
      return;
    }

    const resumeFile = updateResume
      ? (resumeSource === 'new' ? newResume! : profile!.resumeFile)
      : undefined;

    setStarting(true);
    acceptEventsRef.current = true;
    setLocalLogs([{ status: 'searching', reason: 'Starting Naukri profile update…' }]);
    setOpen(true);
    setStatusOpen(true);

    try {
      if (profile && updateHeadline && headline.trim() !== (profile.naukriResumeHeadline ?? '')) {
        const next = { ...profile, naukriResumeHeadline: headline.trim() };
        try {
          await saveProfile(next);
          onProfileUpdated?.(next);
        } catch {
          // continue even if locked
        }
      }

      if (profile && updateResume && resumeSource === 'new' && newResume) {
        const next = { ...profile, resumeFile: newResume };
        try {
          await saveProfile(next);
          onProfileUpdated?.(next);
        } catch {
          // continue
        }
      }

      chrome.runtime.sendMessage({
        type: 'UPDATE_NAUKRI_PROFILE',
        payload: {
          updateResume,
          updateHeadline,
          useExistingResume: resumeSource === 'existing',
          resumeFile,
          headline: headline.trim(),
        },
      }, (response) => {
        if (chrome.runtime.lastError) {
          setStarting(false);
          setStatusOpen(false);
          setError(chrome.runtime.lastError.message || 'Failed to start');
          return;
        }
        if (!response?.ok) {
          setStarting(false);
          setStatusOpen(false);
          setError(response?.error || 'Failed to start Naukri profile update');
          return;
        }
        if (response.runId) setRunId(response.runId);
        setRunMode('naukri-profile');
        setStarting(false);
      });
    } catch (err) {
      setStarting(false);
      setStatusOpen(false);
      setError(err instanceof Error ? err.message : 'Failed to start');
    }
  };

  const handleStop = () => {
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
    // Block late status events immediately, then tell background/content to halt
    acceptEventsRef.current = false;
    setRunning(false);
    setRunMode('idle');
    setStarting(false);
    setStatusOpen(false);
    setLocalLogs((prev) => [...prev, { status: 'interrupted', reason: 'Stopped by user' }]);
    setDoneMessage('Stopped.');
    chrome.runtime.sendMessage({ type: 'STOP_APPLY' }, () => {
      // ignore — UI already reset
    });
  };

  return (
    <div className="section-card space-y-3">
      <button
        type="button"
        className="w-full flex items-center justify-between text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <div>
          <div className="font-semibold text-sm">Update Naukri profile</div>
          <p className="text-xs text-muted mt-0.5">
            Push resume and/or headline to your Naukri profile
          </p>
        </div>
        <span className="text-lg leading-none text-gray-500">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="space-y-4 border-t pt-3">
          {lockedByApply && (
            <div className="bg-amber-50 text-amber-800 text-xs p-2 rounded">
              Job apply is running — finish or stop it before updating Naukri profile.
            </div>
          )}

          <label className="check-row">
            <input
              type="checkbox"
              checked={updateResume}
              onChange={(e) => setUpdateResume(e.target.checked)}
              disabled={busy || lockedByApply}
            />
            <span>Update resume on Naukri</span>
          </label>

          {updateResume && (
            <div className="space-y-2 pl-1">
              <label className="check-row">
                <input
                  type="radio"
                  name="naukri-resume-source"
                  checked={resumeSource === 'existing'}
                  onChange={() => setResumeSource('existing')}
                  disabled={busy || lockedByApply}
                />
                <span>
                  Use existing uploaded resume
                  {profile?.resumeFile?.fileName ? ` (${profile.resumeFile.fileName})` : ' (none saved)'}
                </span>
              </label>
              <label className="check-row">
                <input
                  type="radio"
                  name="naukri-resume-source"
                  checked={resumeSource === 'new'}
                  onChange={() => setResumeSource('new')}
                  disabled={busy || lockedByApply}
                />
                <span>Upload a new resume</span>
              </label>
              {resumeSource === 'new' && (
                <ResumeUpload
                  fileName={newResume?.fileName}
                  disabled={busy || lockedByApply}
                  onFile={handleNewResume}
                />
              )}
              <p className="text-xs text-muted">
                Any resume filename works — today’s date is appended (e.g. MyCV_27-07-2026.pdf).
              </p>
            </div>
          )}

          <label className="check-row">
            <input
              type="checkbox"
              checked={updateHeadline}
              onChange={(e) => setUpdateHeadline(e.target.checked)}
              disabled={busy || lockedByApply}
            />
            <span>Update resume headline</span>
          </label>

          {updateHeadline && (
            <div>
              <label>Resume headline (last saved)</label>
              <textarea
                rows={3}
                value={headline}
                onChange={(e) => setHeadline(e.target.value.slice(0, 250))}
                disabled={busy || lockedByApply}
                placeholder="e.g. Full Stack Developer | React.js | Node.js"
              />
              <p className="text-xs text-muted mt-1">{headline.length}/250 characters</p>
            </div>
          )}

          {error && (
            <div className="bg-red-50 text-red-700 text-xs p-2 rounded dark:bg-red-950/40 dark:text-red-300">{error}</div>
          )}

          {doneMessage && (
            <div className="bg-green-50 text-green-800 text-xs p-2 rounded dark:bg-green-950/40 dark:text-green-300">
              {doneMessage}
            </div>
          )}

          {(busy || localLogs.length > 0) && (
            <div className="rounded border border-gray-200 dark:border-gray-700">
              <button
                type="button"
                className="w-full flex items-center justify-between px-2 py-1.5 text-left"
                onClick={() => setStatusOpen((v) => !v)}
              >
                <span className="text-xs font-medium text-muted">
                  Status History{busy ? ' · running' : ''}
                </span>
                <span className="text-sm leading-none text-gray-500">{statusOpen ? '▾' : '▸'}</span>
              </button>
              {statusOpen && (
                <div className="border-t border-gray-200 dark:border-gray-700 p-2 space-y-1 max-h-40 overflow-y-auto">
                  {localLogs.map((log, i) => (
                    <div
                      key={`${log.status}-${i}-${log.reason}`}
                      className={`text-xs ${
                        log.status === 'failed' || log.status === 'interrupted'
                          ? 'text-red-600'
                          : log.status === 'applied'
                            ? 'text-green-700'
                            : 'text-blue-700'
                      }`}
                    >
                      {log.reason}
                    </div>
                  ))}
                  {busy && (
                    <div className="text-xs text-muted animate-pulse">Working on Naukri profile…</div>
                  )}
                </div>
              )}
            </div>
          )}

          {busy ? (
            <button type="button" className="btn-danger w-full" onClick={handleStop}>
              Stop profile update
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary w-full"
              disabled={lockedByApply || (!updateResume && !updateHeadline)}
              onClick={() => void handleStart()}
            >
              Update on Naukri
            </button>
          )}
          <p className="text-xs text-muted">
            Opens your Naukri profile tab and applies only the items you checked. Progress stays here.
            After success, the Pro popup is closed; the profile tab stays open.
          </p>
        </div>
      )}
    </div>
  );
}
