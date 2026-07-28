import { create } from 'zustand';
import type { Profile, SearchCriteria, HostToExtensionMessage } from '@job-autoapply/shared';

export type RunMode = 'idle' | 'apply' | 'naukri-profile';

type StatusEvent = Extract<HostToExtensionMessage, { type: 'STATUS_EVENT' }>;

interface AppState {
  activeTab: 'profile' | 'apply' | 'run';
  theme: 'light' | 'dark';
  profile: Profile | null;
  isLocked: boolean;
  hostConnected: boolean;
  tosAcknowledged: boolean;
  isRunning: boolean;
  runMode: RunMode;
  runId: string | null;
  tabTitle: string | null;
  tabUrl: string | null;
  statusEvents: StatusEvent[];
  runSummary: { applied: number; skipped: number; failed: number } | null;
  liveCounters: { applied: number; skipped: number; failed: number } | null;
  runToast: { message: string; tone: 'info' | 'warning' | 'success' | 'error' } | null;
  externalLeads: ExternalCompanyLead[];
  setActiveTab: (tab: 'profile' | 'apply' | 'run') => void;
  setTheme: (theme: 'light' | 'dark') => void;
  setProfile: (profile: Profile | null) => void;
  setLocked: (locked: boolean) => void;
  setHostConnected: (connected: boolean) => void;
  setTosAcknowledged: (ack: boolean) => void;
  setRunning: (running: boolean) => void;
  setRunMode: (mode: RunMode) => void;
  addStatusEvent: (event: StatusEvent) => void;
  setStatusEvents: (events: StatusEvent[]) => void;
  setRunSummary: (summary: { applied: number; skipped: number; failed: number } | null) => void;
  setLiveCounters: (counters: { applied: number; skipped: number; failed: number } | null) => void;
  setRunToast: (toast: { message: string; tone: 'info' | 'warning' | 'success' | 'error' } | null) => void;
  setExternalLeads: (leads: ExternalCompanyLead[]) => void;
  resetRun: () => void;
  setTabInfo: (title: string | null, url: string | null) => void;
  setRunId: (id: string | null) => void;
}

export interface ExternalCompanyLead {
  runId?: string;
  jobTitle: string;
  company: string;
  naukriUrl: string;
  externalUrl?: string;
  skipReason?: string;
  sourceType?: 'company-site' | 'skipped';
  capturedAt: string;
}

export const useAppStore = create<AppState>((set) => ({
  activeTab: 'profile',
  theme: 'light',
  profile: null,
  isLocked: true,
  hostConnected: false,
  tosAcknowledged: false,
  isRunning: false,
  runMode: 'idle',
  runId: null,
  tabTitle: null,
  tabUrl: null,
  statusEvents: [],
  runSummary: null,
  liveCounters: null,
  runToast: null,
  externalLeads: [],
  setActiveTab: (tab) => set({ activeTab: tab }),
  setTheme: (theme) => set({ theme }),
  setProfile: (profile) => set({ profile }),
  setLocked: (locked) => set({ isLocked: locked }),
  setHostConnected: (connected) => set({ hostConnected: connected }),
  setTosAcknowledged: (ack) => set({ tosAcknowledged: ack }),
  setRunning: (running) => set((s) => ({
    isRunning: running,
    runMode: running ? s.runMode : 'idle',
  })),
  setRunMode: (mode) => set({ runMode: mode, isRunning: mode !== 'idle' }),
  addStatusEvent: (event) =>
    set((s) => {
      const key = `${event.status}|${event.jobTitle ?? ''}|${event.company ?? ''}|${event.reason ?? ''}`;
      // Dedupe identical lines regardless of runId (iframes often send null runId)
      if (s.statusEvents.some((e) =>
        `${e.status}|${e.jobTitle ?? ''}|${e.company ?? ''}|${e.reason ?? ''}` === key,
      )) {
        return s;
      }
      return { statusEvents: [...s.statusEvents, event] };
    }),
  setStatusEvents: (events) => set({
    statusEvents: events.filter((event, index, all) => {
      const key = `${event.status}|${event.jobTitle ?? ''}|${event.company ?? ''}|${event.reason ?? ''}`;
      return all.findIndex((e) =>
        `${e.status}|${e.jobTitle ?? ''}|${e.company ?? ''}|${e.reason ?? ''}` === key,
      ) === index;
    }),
  }),
  setRunSummary: (summary) => set({ runSummary: summary }),
  setLiveCounters: (counters) => set({ liveCounters: counters }),
  setRunToast: (toast) => set({ runToast: toast }),
  setExternalLeads: (leads) => set({ externalLeads: leads }),
  resetRun: () =>
    set({
      statusEvents: [],
      runSummary: null,
      liveCounters: null,
      runToast: null,
      externalLeads: [],
      isRunning: false,
      runMode: 'idle',
      runId: null,
      tabTitle: null,
      tabUrl: null,
    }),
  setTabInfo: (title, url) => set({ tabTitle: title, tabUrl: url }),
  setRunId: (id) => set({ runId: id }),
}));

export const defaultSearchCriteria = (): SearchCriteria => ({
  platform: 'linkedin',
  jobTitles: '',
  location: '',
  experienceLevel: '',
  notificationEmail: '',
  datePosted: 'Past week',
  easyApplyOnly: true,
  dailyApplicationCap: 25,
});
