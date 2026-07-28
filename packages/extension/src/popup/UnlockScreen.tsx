import { useState } from 'react';
import { setupEncryption, unlockWithPassphrase } from '../lib/storage';

interface UnlockScreenProps {
  mode: 'setup' | 'unlock';
  onUnlocked: () => void;
  message?: string;
}

export function UnlockScreen({ mode, onUnlocked, message }: UnlockScreenProps) {
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSetup = async () => {
    setError('');
    if (passphrase.length < 8) {
      setError('Passphrase must be at least 8 characters');
      return;
    }
    if (passphrase !== confirm) {
      setError('Passphrases do not match');
      return;
    }
    setLoading(true);
    try {
      await setupEncryption(passphrase);
      onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setLoading(false);
    }
  };

  const handleUnlock = async () => {
    setError('');
    setLoading(true);
    try {
      const ok = await unlockWithPassphrase(passphrase);
      if (ok) {
        onUnlocked();
      } else {
        setError('Incorrect passphrase');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unlock failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold">
          {mode === 'setup' ? 'Create encryption passphrase' : 'Unlock your profile'}
        </h2>
        <p className="text-xs text-gray-500 mt-1">
          {mode === 'setup'
            ? 'Your profile is encrypted locally. Choose a passphrase you will remember.'
            : 'Enter your passphrase each time you open the extension.'}
        </p>
      </div>

      {message && (
        <div className="bg-yellow-50 text-yellow-800 text-xs p-2 rounded">{message}</div>
      )}

      {error && (
        <div className="bg-red-50 text-red-700 text-xs p-2 rounded">{error}</div>
      )}

      <div>
        <label>Passphrase</label>
        <input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (mode === 'setup' ? handleSetup() : handleUnlock())}
          autoFocus
        />
      </div>

      {mode === 'setup' && (
        <div>
          <label>Confirm passphrase</label>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSetup()}
          />
        </div>
      )}

      <button
        className="btn-primary w-full"
        disabled={loading || !passphrase}
        onClick={mode === 'setup' ? handleSetup : handleUnlock}
      >
        {loading ? 'Please wait...' : mode === 'setup' ? 'Create & unlock' : 'Unlock'}
      </button>
    </div>
  );
}
