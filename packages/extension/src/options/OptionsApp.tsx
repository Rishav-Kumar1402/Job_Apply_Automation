import { useState, useEffect } from 'react';
import {
  setupEncryption,
  unlockWithPassphrase,
  getStorageStatus,
  lockStorage,
  clearAllData,
} from '../lib/storage';
import '../styles/global.css';

function OptionsApp() {
  const [passphrase, setPassphrase] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [unlockPass, setUnlockPass] = useState('');
  const [hasSetup, setHasSetup] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [message, setMessage] = useState('');

  const [brevoApiKey, setBrevoApiKey] = useState('');
  const [brevoHasKey, setBrevoHasKey] = useState(false);
  const [brevoSenderEmail, setBrevoSenderEmail] = useState('');
  const [brevoSenderName, setBrevoSenderName] = useState('Job Auto-Apply');
  const [brevoRelayUrl, setBrevoRelayUrl] = useState('');
  const [testToEmail, setTestToEmail] = useState('');
  const [brevoBusy, setBrevoBusy] = useState(false);

  useEffect(() => {
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
    getStorageStatus().then(({ hasSetup, isUnlocked }) => {
      setHasSetup(hasSetup);
      setUnlocked(isUnlocked);
    });
    chrome.runtime.sendMessage({ type: 'GET_BREVO_SETTINGS' }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) return;
      const settings = response.settings ?? {};
      setBrevoHasKey(Boolean(settings.hasApiKey));
      setBrevoSenderEmail(settings.senderEmail ?? '');
      setBrevoSenderName(settings.senderName || 'Job Auto-Apply');
      setBrevoRelayUrl(settings.relayUrl ?? '');
      setTestToEmail(settings.senderEmail ?? '');
    });
  }, []);

  const handleSetup = async () => {
    if (passphrase.length < 8) {
      setMessage('Passphrase must be at least 8 characters');
      return;
    }
    if (passphrase !== confirmPass) {
      setMessage('Passphrases do not match');
      return;
    }
    await setupEncryption(passphrase);
    setHasSetup(true);
    setUnlocked(true);
    setMessage('Encryption configured.');
  };

  const handleUnlock = async () => {
    const ok = await unlockWithPassphrase(unlockPass);
    setUnlocked(ok);
    setMessage(ok ? 'Unlocked.' : 'Incorrect passphrase.');
  };

  const handleClear = async () => {
    if (!window.confirm('Delete all profile data and preferences?')) return;
    await clearAllData();
    setHasSetup(false);
    setUnlocked(false);
    setMessage('All data cleared.');
  };

  const saveBrevoSettings = (extra?: { clearApiKey?: boolean }) => {
    setBrevoBusy(true);
    chrome.runtime.sendMessage({
      type: 'SAVE_BREVO_SETTINGS',
      payload: {
        apiKey: brevoApiKey,
        senderEmail: brevoSenderEmail,
        senderName: brevoSenderName,
        relayUrl: brevoRelayUrl,
        clearApiKey: extra?.clearApiKey,
      },
    }, (response) => {
      setBrevoBusy(false);
      if (chrome.runtime.lastError || !response?.ok) {
        setMessage(chrome.runtime.lastError?.message || response?.error || 'Failed to save Brevo settings');
        return;
      }
      if (extra?.clearApiKey) {
        setBrevoApiKey('');
        setBrevoHasKey(false);
        setMessage('Brevo API key cleared.');
        return;
      }
      if (brevoApiKey.trim()) {
        setBrevoHasKey(true);
        setBrevoApiKey('');
      }
      setMessage('Brevo settings saved on this device.');
    });
  };

  const testBrevoEmail = () => {
    setBrevoBusy(true);
    chrome.runtime.sendMessage({
      type: 'TEST_BREVO_EMAIL',
      payload: { toEmail: testToEmail || brevoSenderEmail },
    }, (response) => {
      setBrevoBusy(false);
      if (chrome.runtime.lastError) {
        setMessage(chrome.runtime.lastError.message || 'Test email failed');
        return;
      }
      if (response?.ok && response.via === 'brevo') {
        setMessage('Test email sent via Brevo. Check inbox (and spam).');
        return;
      }
      setMessage(response?.error || `Email fallback used (${response?.via || 'unknown'}).`);
    });
  };

  return (
    <div className="max-w-2xl mx-auto p-8 space-y-8">
      <header>
        <h1 className="text-2xl font-bold">Job Auto-Apply — Settings</h1>
        <p className="text-gray-600 text-sm mt-1">Encryption, email reports, and data management</p>
      </header>

      {message && (
        <div className="bg-blue-50 text-blue-800 text-sm p-3 rounded">{message}</div>
      )}

      <section className="border rounded-lg p-6 space-y-4">
        <h2 className="text-lg font-semibold">Encryption Passphrase</h2>
        {!hasSetup ? (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">Encrypts your profile locally on this device.</p>
            <div>
              <label>Passphrase</label>
              <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            </div>
            <div>
              <label>Confirm Passphrase</label>
              <input type="password" value={confirmPass} onChange={(e) => setConfirmPass(e.target.value)} />
            </div>
            <button className="btn-primary" onClick={handleSetup}>Set Passphrase</button>
          </div>
        ) : !unlocked ? (
          <div className="space-y-3">
            <div>
              <label>Unlock with Passphrase</label>
              <input type="password" value={unlockPass} onChange={(e) => setUnlockPass(e.target.value)} />
            </div>
            <button className="btn-primary" onClick={handleUnlock}>Unlock</button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-green-700">Storage is unlocked.</p>
            <button className="btn-secondary" onClick={async () => { await lockStorage(); setUnlocked(false); }}>
              Lock Storage
            </button>
          </div>
        )}
      </section>

      <section className="border rounded-lg p-6 space-y-4">
        <h2 className="text-lg font-semibold">Brevo email reports</h2>
        <p className="text-sm text-gray-600">
          Sends the company-site / skipped-jobs table in the email body with a CSV attachment.
          Use a verified Brevo sender. Store the API key only here — never commit it.
        </p>
        <div>
          <label>Brevo API key {brevoHasKey ? '(saved)' : ''}</label>
          <input
            type="password"
            value={brevoApiKey}
            onChange={(e) => setBrevoApiKey(e.target.value)}
            placeholder={brevoHasKey ? '•••••••• (paste a new key to replace)' : 'xkeysib-...'}
            autoComplete="off"
          />
        </div>
        <div>
          <label>Verified sender email *</label>
          <input
            type="email"
            value={brevoSenderEmail}
            onChange={(e) => setBrevoSenderEmail(e.target.value)}
            placeholder="you@gmail.com"
          />
        </div>
        <div>
          <label>Sender name</label>
          <input
            type="text"
            value={brevoSenderName}
            onChange={(e) => setBrevoSenderName(e.target.value)}
            placeholder="Job Auto-Apply"
          />
        </div>
        <div>
          <label>Optional relay URL (Cloudflare Worker)</label>
          <input
            type="url"
            value={brevoRelayUrl}
            onChange={(e) => setBrevoRelayUrl(e.target.value)}
            placeholder="https://job-report.your-name.workers.dev"
          />
          <p className="text-xs text-gray-500 mt-1">
            If set, the extension calls this URL instead of Brevo directly (safer for shared builds).
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" disabled={brevoBusy} onClick={() => saveBrevoSettings()}>
            Save Brevo settings
          </button>
          {brevoHasKey && (
            <button className="btn-secondary" disabled={brevoBusy} onClick={() => saveBrevoSettings({ clearApiKey: true })}>
              Clear API key
            </button>
          )}
        </div>
        <div className="border-t pt-4 space-y-3">
          <div>
            <label>Send test email to</label>
            <input
              type="email"
              value={testToEmail}
              onChange={(e) => setTestToEmail(e.target.value)}
              placeholder="you@gmail.com"
            />
          </div>
          <button className="btn-secondary" disabled={brevoBusy} onClick={testBrevoEmail}>
            Send test email
          </button>
        </div>
      </section>

      <section className="border border-red-200 rounded-lg p-6 space-y-4">
        <h2 className="text-lg font-semibold text-red-700">Clear All Data</h2>
        <button className="btn-danger" onClick={handleClear}>Clear All My Data</button>
      </section>
    </div>
  );
}

export default OptionsApp;
