export const NATIVE_HOST_NAME = 'com.jobautoapply.host';

export const DEFAULT_DAILY_CAP = 25;
export const MAX_DAILY_CAP = 100;
export const MIN_DAILY_CAP = 1;

export const DEFAULT_CDP_PORT = 9222;
export const CDP_ENDPOINT = `http://127.0.0.1:${DEFAULT_CDP_PORT}`;

export const RESUME_MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
export const RESUME_ALLOWED_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;
export const RESUME_ALLOWED_EXTENSIONS = ['.pdf', '.docx'] as const;

export const ACTION_DELAY_MS = { min: 3000, max: 12000 } as const;
export const APPLICATION_DELAY_MS = { min: 30000, max: 90000 } as const;

export const PLATFORM_URLS = {
  linkedin: 'https://www.linkedin.com',
  naukri: 'https://www.naukri.com',
} as const;

export const STORAGE_KEYS = {
  encryptedProfile: 'encryptedProfile',
  encryptionSalt: 'encryptionSalt',
  keyCheckValue: 'keyCheckValue',
  uiPreferences: 'uiPreferences',
  tosAcknowledged: 'tosAcknowledged',
  hostConnected: 'hostConnected',
  /** Last headline pushed to Naukri — plain local so it survives a locked profile. */
  lastNaukriHeadline: 'lastNaukriHeadline',
} as const;
