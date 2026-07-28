import {
  STORAGE_KEYS,
  profileSchema,
  uiPreferencesSchema,
  type Profile,
  type UiPreferences,
} from '@job-autoapply/shared';

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

/** In-memory only — cleared when the last extension UI port disconnects. */
let cachedKey: CryptoKey | null = null;

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function deriveKey(passphrase: string, salt: BufferSource): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

async function getOrCreateSalt(): Promise<Uint8Array> {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.encryptionSalt] as string[]);
  if (stored[STORAGE_KEYS.encryptionSalt]) {
    return new Uint8Array(base64ToBuffer(stored[STORAGE_KEYS.encryptionSalt] as string));
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  await chrome.storage.local.set({
    [STORAGE_KEYS.encryptionSalt]: bufferToBase64(salt.buffer as ArrayBuffer),
  });
  return salt;
}

export async function getStorageStatus(): Promise<{ hasSetup: boolean; isUnlocked: boolean }> {
  const hasSetup = await hasEncryptionSetup();
  return { hasSetup, isUnlocked: cachedKey !== null };
}

export async function hasEncryptionSetup(): Promise<boolean> {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.keyCheckValue] as string[]);
  return Boolean(stored[STORAGE_KEYS.keyCheckValue]);
}

export async function setupEncryption(passphrase: string): Promise<void> {
  if (passphrase.length < 8) {
    throw new Error('Passphrase must be at least 8 characters');
  }

  const salt = await getOrCreateSalt();
  const key = await deriveKey(passphrase, salt as BufferSource);
  cachedKey = key;

  const enc = new TextEncoder();
  const checkIv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const checkCipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: checkIv },
    key,
    enc.encode('job-autoapply-key-check'),
  );

  await chrome.storage.local.set({
    [STORAGE_KEYS.keyCheckValue]: JSON.stringify({
      iv: bufferToBase64(checkIv.buffer),
      data: bufferToBase64(checkCipher),
    }),
  });
}

export async function unlockWithPassphrase(passphrase: string): Promise<boolean> {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.encryptionSalt,
    STORAGE_KEYS.keyCheckValue,
  ] as string[]);

  const saltB64 = stored[STORAGE_KEYS.encryptionSalt] as string | undefined;
  const checkB64 = stored[STORAGE_KEYS.keyCheckValue] as string | undefined;
  if (!saltB64 || !checkB64) return false;

  const salt = new Uint8Array(base64ToBuffer(saltB64));
  const key = await deriveKey(passphrase, salt as BufferSource);

  try {
    const check = JSON.parse(checkB64) as { iv: string; data: string };
    const dec = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(base64ToBuffer(check.iv)) },
      key,
      base64ToBuffer(check.data),
    );
    const text = new TextDecoder().decode(dec);
    if (text === 'job-autoapply-key-check') {
      cachedKey = key;
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export async function lockStorage(): Promise<void> {
  cachedKey = null;
  // Clear any key left from older builds that persisted unlock across UI closes.
  try {
    await chrome.storage.session.remove('sessionDerivedKey');
  } catch {
    // ignore
  }
}

async function getKey(): Promise<CryptoKey> {
  if (!cachedKey) {
    throw new Error('Storage is locked. Enter your passphrase to unlock.');
  }
  return cachedKey;
}

export async function saveProfile(profile: Profile): Promise<void> {
  const parsed = profileSchema.parse(profile);
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const enc = new TextEncoder();
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(JSON.stringify(parsed)),
  );

  await chrome.storage.local.set({
    [STORAGE_KEYS.encryptedProfile]: JSON.stringify({
      iv: bufferToBase64(iv.buffer),
      data: bufferToBase64(cipher),
    }),
  });
}

export async function loadProfile(): Promise<Profile | null> {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.encryptedProfile] as string[]);
  const encrypted = stored[STORAGE_KEYS.encryptedProfile] as string | undefined;
  if (!encrypted) return null;

  const key = await getKey();
  const { iv, data } = JSON.parse(encrypted) as { iv: string; data: string };
  const dec = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(base64ToBuffer(iv)) },
    key,
    base64ToBuffer(data),
  );

  const profile = JSON.parse(new TextDecoder().decode(dec));
  return profileSchema.parse(profile);
}

export async function clearAllData(): Promise<void> {
  await lockStorage();
  await chrome.storage.local.clear();
}

export async function saveUiPreferences(prefs: UiPreferences): Promise<void> {
  const parsed = uiPreferencesSchema.parse(prefs);
  await chrome.storage.local.set({ [STORAGE_KEYS.uiPreferences]: parsed });
}

export async function loadUiPreferences(): Promise<UiPreferences> {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.uiPreferences] as string[]);
  const prefs = stored[STORAGE_KEYS.uiPreferences];
  if (!prefs) return {};
  return uiPreferencesSchema.parse(prefs);
}

export async function isTosAcknowledged(): Promise<boolean> {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.tosAcknowledged] as string[]);
  return Boolean(stored[STORAGE_KEYS.tosAcknowledged]);
}

export async function acknowledgeTos(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.tosAcknowledged]: true });
}
