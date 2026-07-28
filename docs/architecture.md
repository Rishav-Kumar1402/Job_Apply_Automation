# Architecture

## Overview

Job Auto-Apply uses a hybrid architecture: a Chrome Extension for UI and control, and a local Node.js native messaging host for Playwright automation.

```
┌─────────────────────────┐        Native Messaging        ┌──────────────────────────┐
│   Chrome Extension       │ <-----------------------------> │  Local Node.js Host       │
│  - Popup UI              │        (stdio JSON RPC)         │  - Playwright CDP attach  │
│  - Options page           │                                 │  - Search / apply logic   │
│  - chrome.storage.local   │        Status/log events         │  - SQLite dedupe/logs     │
└─────────────────────────┘ <-----------------------------> └──────────────────────────┘
```

## Why Hybrid?

Manifest V3 extensions cannot run Node.js or Playwright. Native Messaging bridges the extension sandbox to a local automation process.

## CDP Attach (No Headless)

Playwright connects to the user's existing Chrome via `chromium.connectOverCDP()`. This:

- Reuses the logged-in LinkedIn/Naukri session
- Runs visibly in the user's real browser window
- Never falls back to headless mode

## Data Flow

1. User saves encrypted profile in extension (`chrome.storage.local`)
2. User clicks Start → extension sends `START_APPLY` with profile + criteria
3. Host attaches via CDP, runs platform automation, streams `STATUS_EVENT`s
4. Host persists outcomes to SQLite for dedupe and history
5. On completion, host sends `RUN_SUMMARY`

## Packages

| Package | Role |
|---|---|
| `packages/extension` | MV3 UI, encryption, native messaging client |
| `packages/host` | Playwright engine, SQLite, logging |
| `packages/shared` | Zod schemas, IPC types |
