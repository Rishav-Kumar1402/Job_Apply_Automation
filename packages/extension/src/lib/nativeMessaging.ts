import {
  NATIVE_HOST_NAME,
  type ExtensionToHostMessage,
  type HostToExtensionMessage,
} from '@job-autoapply/shared';

export type NativeMessageHandler = (message: HostToExtensionMessage) => void;

let port: chrome.runtime.Port | null = null;
const listeners = new Set<NativeMessageHandler>();

export function connectNative(): chrome.runtime.Port | null {
  if (port) return port;

  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch {
    return null;
  }

  port.onMessage.addListener((message: HostToExtensionMessage) => {
    listeners.forEach((fn) => fn(message));
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message;
    port = null;
    chrome.storage.local.set({ hostConnected: false, hostLastError: err ?? null });
    if (err) {
      console.warn('Native host disconnected:', err);
    }
  });

  return port;
}

export function disconnectNative(): void {
  port?.disconnect();
  port = null;
}

export function sendToHost(message: ExtensionToHostMessage): boolean {
  const p = connectNative();
  if (!p) return false;
  try {
    p.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

export function onHostMessage(handler: NativeMessageHandler): () => void {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

export interface PingResult {
  connected: boolean;
  error?: string;
}

export async function pingHost(): Promise<PingResult> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      chrome.storage.local.get(['hostLastError'], (stored) => {
        resolve({
          connected: false,
          error: (stored.hostLastError as string) || 'Host did not respond. Re-run the install script.',
        });
      });
    }, 5000);

    const unsubscribe = onHostMessage((msg) => {
      if (msg.type === 'PING_RESPONSE') {
        clearTimeout(timeout);
        unsubscribe();
        chrome.storage.local.set({ hostConnected: true, hostLastError: null });
        resolve({ connected: true });
      }
    });

    if (!sendToHost({ type: 'PING' })) {
      clearTimeout(timeout);
      unsubscribe();
      chrome.storage.local.get(['hostLastError'], (stored) => {
        resolve({
          connected: false,
          error: (stored.hostLastError as string) || `Could not connect to native host "${NATIVE_HOST_NAME}". Run the install script.`,
        });
      });
    }
  });
}
