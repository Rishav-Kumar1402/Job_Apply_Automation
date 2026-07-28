import type { Profile, SearchCriteria } from './profileSchema.js';

export type ApplicationStatus =
  | 'searching'
  | 'applied'
  | 'skipped'
  | 'failed'
  | 'interrupted';

export type HostToExtensionMessage =
  | StatusEvent
  | RunSummary
  | HostError
  | PingResponse
  | HistoryResponse
  | RunStarted;

export type ExtensionToHostMessage =
  | StartApply
  | StopApply
  | GetHistory
  | Ping
  | GetRunSummary
  | ClearData;

export interface StartApply {
  type: 'START_APPLY';
  platform: 'linkedin' | 'naukri';
  profile: Profile;
  criteria: SearchCriteria;
  cdpPort?: number;
  tabUrl?: string;
}

export interface StopApply {
  type: 'STOP_APPLY';
  runId: string;
}

export interface GetHistory {
  type: 'GET_HISTORY';
  runId?: string;
  limit?: number;
}

export interface GetRunSummary {
  type: 'GET_RUN_SUMMARY';
  runId: string;
}

export interface ClearData {
  type: 'CLEAR_DATA';
}

export interface Ping {
  type: 'PING';
}

export interface StatusEvent {
  type: 'STATUS_EVENT';
  runId: string;
  status: ApplicationStatus;
  jobTitle?: string;
  company?: string;
  reason?: string;
  tabTitle?: string;
  tabUrl?: string;
}

export interface RunSummary {
  type: 'RUN_SUMMARY';
  runId: string;
  applied: number;
  skipped: number;
  failed: number;
  interrupted?: number;
}

export interface RunStarted {
  type: 'RUN_STARTED';
  runId: string;
  tabTitle?: string;
  tabUrl?: string;
}

export interface HostError {
  type: 'HOST_ERROR';
  code: string;
  message: string;
}

export interface PingResponse {
  type: 'PING_RESPONSE';
  version: string;
  connected: true;
}

export interface HistoryEntry {
  id: number;
  runId: string;
  jobId: string;
  jobTitle: string;
  company: string;
  platform: string;
  status: string;
  reason: string | null;
  createdAt: string;
}

export interface HistoryResponse {
  type: 'HISTORY_RESPONSE';
  entries: HistoryEntry[];
}

export interface ApplicationRecord {
  jobId: string;
  jobTitle: string;
  company: string;
  platform: 'linkedin' | 'naukri';
  status: 'applied' | 'skipped' | 'failed';
  reason?: string;
}
