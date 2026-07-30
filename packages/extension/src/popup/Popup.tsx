import { useEffect, useRef, useState, useCallback } from 'react';
import {
  getStorageStatus,
  loadProfile,
  isTosAcknowledged,
} from '../lib/storage';
import { useAppStore } from './store';
import { ProfileTab } from './tabs/ProfileTab';
import { ApplyTab } from './tabs/ApplyTab';
import { RunDashboardTab } from './tabs/RunDashboardTab';
import { UnlockScreen } from './UnlockScreen';

type GateState = 'loading' | 'setup' | 'unlock' | 'ready';

export function Popup() {
  const {
    activeTab,
    theme,
    setActiveTab,
    setTheme,
    setProfile,
    setTosAcknowledged,
    isRunning,
    runMode,
    setRunning,
    setRunMode,
  } = useAppStore();
  const [gate, setGate] = useState<GateState>('loading');
  const [lockMessage, setLockMessage] = useState<string | undefined>();

  const profileTabDisabled = isRunning && runMode === 'apply';
  const otherTabsDisabled = isRunning && runMode === 'naukri-profile';

  /** The passphrase is asked once per opened UI, even if the worker still holds the key. */
  const unlockedHereRef = useRef(false);

  const refreshGate = useCallback(async () => {
    const status = await getStorageStatus();
    if (!status.hasSetup) {
      setGate('setup');
    } else if (!status.isUnlocked || !unlockedHereRef.current) {
      setGate('unlock');
    } else {
      setLockMessage(undefined);
      setGate('ready');
      const p = await loadProfile();
      if (p) setProfile(p);
    }
  }, [setProfile]);

  useEffect(() => {
    // Keep storage unlocked only while this UI is open; closing locks again.
    const port = chrome.runtime.connect({ name: 'ui-session' });
    return () => {
      try {
        port.disconnect();
      } catch {
        // ignore
      }
    };
  }, []);

  useEffect(() => {
    (async () => {
      await refreshGate();
      const tos = await isTosAcknowledged();
      setTosAcknowledged(tos);
    })();
  }, [refreshGate, setTosAcknowledged]);

  useEffect(() => {
    const savedTheme = localStorage.getItem('job-autoapply-theme') === 'dark' ? 'dark' : 'light';
    setTheme(savedTheme);
  }, [setTheme]);

  useEffect(() => {
    document.body.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('job-autoapply-theme', theme);
  }, [theme]);

  if (gate === 'loading') {
    return <div className="p-4 text-sm text-gray-500">Loading...</div>;
  }

  if (gate === 'setup' || gate === 'unlock') {
    return (
      <div className="app-shell">
        <header className="app-header">
          <div className="flex items-center gap-2.5">
            <img
              src={chrome.runtime.getURL('public/icons/icon48.png')}
              alt=""
              width={32}
              height={32}
              className="rounded-md bg-white"
            />
            <h1 className="text-base font-semibold">Auto-Apply Jobs</h1>
          </div>
        </header>
        <UnlockScreen
          mode={gate}
          message={lockMessage}
          onUnlocked={() => {
            unlockedHereRef.current = true;
            void refreshGate();
          }}
        />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="flex items-center gap-2.5 min-w-0">
          <img
            src={chrome.runtime.getURL('public/icons/icon48.png')}
            alt=""
            width={36}
            height={36}
            className="rounded-md shrink-0 bg-white"
          />
          <div className="min-w-0">
            <h1 className="text-base font-semibold tracking-tight">Auto-Apply Jobs</h1>
            <p className="text-xs opacity-85">LinkedIn & Naukri automation</p>
          </div>
        </div>
        <button
          type="button"
          className="theme-toggle"
          aria-label="Toggle light and dark mode"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          <span>{theme === 'dark' ? 'Light' : 'Dark'}</span>
        </button>
      </header>

      <nav className="tab-nav">
        {(['profile', 'apply', 'run'] as const).map((tab) => {
          const disabled = (tab === 'profile' && profileTabDisabled)
            || ((tab === 'apply' || tab === 'run') && otherTabsDisabled);
          return (
            <button
              key={tab}
              type="button"
              disabled={disabled}
              title={
                disabled
                  ? (tab === 'profile'
                    ? 'Finish or stop job apply first'
                    : 'Finish or stop Naukri profile update first')
                  : undefined
              }
              className={`tab-btn ${activeTab === tab ? 'tab-btn-active' : 'tab-btn-inactive'} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
              onClick={() => {
                if (disabled) return;
                setActiveTab(tab);
              }}
            >
              {tab === 'profile' ? 'Profile' : tab === 'apply' ? 'Apply' : 'Run'}
              {tab === 'run' && isRunning && runMode === 'apply' && ' •'}
            </button>
          );
        })}
      </nav>

      {isRunning && (
        <div className="px-3 pt-2">
          <button
            type="button"
            className="btn-danger w-full text-sm"
            onClick={() => {
              // Reset immediately — waiting for the response let a late status event
              // flip the UI back to "Running" before the callback arrived
              setRunning(false);
              setRunMode('idle');
              chrome.runtime.sendMessage({ type: 'STOP_APPLY' }, () => {
                setRunning(false);
                setRunMode('idle');
              });
            }}
          >
            Stop automation
          </button>
        </div>
      )}

      {activeTab === 'profile' && (
        <ProfileTab
          onLocked={() => {
            unlockedHereRef.current = false;
            setLockMessage('Your session expired. Enter your passphrase to save your profile.');
            setGate('unlock');
          }}
        />
      )}
      {activeTab === 'apply' && <ApplyTab />}
      {activeTab === 'run' && <RunDashboardTab />}
    </div>
  );
}
