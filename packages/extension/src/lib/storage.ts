import type { Profile, UiPreferences } from '@job-autoapply/shared';

type StorageResponse<T> = { ok: true; data: T } | { ok: false; error: string };

async function storageRequest<T>(action: string, payload?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'STORAGE', action, payload }, (response: StorageResponse<T>) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error ?? 'Storage request failed'));
        return;
      }
      resolve(response.data);
    });
  });
}

export async function getStorageStatus(): Promise<{ hasSetup: boolean; isUnlocked: boolean }> {
  return storageRequest('status');
}

export async function hasEncryptionSetup(): Promise<boolean> {
  const status = await getStorageStatus();
  return status.hasSetup;
}

export async function isUnlocked(): Promise<boolean> {
  const status = await getStorageStatus();
  return status.isUnlocked;
}

export async function setupEncryption(passphrase: string): Promise<void> {
  await storageRequest('setup', { passphrase });
}

export async function unlockWithPassphrase(passphrase: string): Promise<boolean> {
  return storageRequest('unlock', { passphrase });
}

export async function lockStorage(): Promise<void> {
  await storageRequest('lock');
}

export async function saveProfile(profile: Profile): Promise<void> {
  await storageRequest('saveProfile', { profile });
}

export async function loadProfile(): Promise<Profile | null> {
  return storageRequest('loadProfile');
}

export async function clearAllData(): Promise<void> {
  await storageRequest('clear');
}

export async function saveUiPreferences(prefs: UiPreferences): Promise<void> {
  await storageRequest('saveUiPreferences', { prefs });
}

export async function loadUiPreferences(): Promise<UiPreferences> {
  return storageRequest('loadUiPreferences');
}

export async function isTosAcknowledged(): Promise<boolean> {
  return storageRequest('isTosAcknowledged');
}

export async function acknowledgeTos(): Promise<void> {
  await storageRequest('acknowledgeTos');
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function readResumeFile(file: File): Promise<Profile['resumeFile']> {
  const allowed = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];
  if (!allowed.includes(file.type)) {
    throw new Error('Resume must be PDF or DOCX');
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new Error('Resume must be under 5 MB');
  }

  const buffer = await file.arrayBuffer();
  return {
    fileName: file.name,
    mimeType: file.type,
    base64: bufferToBase64(buffer),
    sizeBytes: file.size,
  };
}
