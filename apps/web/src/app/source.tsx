import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  createTrialStream,
  type BackoffPolicy,
  type StreamSnapshot,
  type StreamTransport,
} from '../model/liveStream.js';
import {
  createSseTransport,
  isSafeBaseUrl,
  type SseTransportOptions,
} from '../model/sseTransport.js';

/**
 * Where case pages get their events. `fake` replays the recorded fixtures (the default, and what
 * the corpus list uses). `live` streams GET /cases/:id/events from the API.
 */
export type SourceConfig =
  | { mode: 'fake' }
  | { mode: 'live'; transport: StreamTransport; backoff?: BackoffPolicy; maxEvents?: number }
  /** Live was requested but the API URL is missing or not allowed. */
  | { mode: 'config-error' };

const SourceContext = createContext<SourceConfig>({ mode: 'fake' });
export const SourceProvider = SourceContext.Provider;
export const useSourceConfig = (): SourceConfig => useContext(SourceContext);

/** Env values as Vite exposes them. All optional. */
export interface WebEnv {
  VITE_AFFIDAVIT_SOURCE?: string | undefined;
  VITE_AFFIDAVIT_API_URL?: string | undefined;
}

/** Asking for live data with a missing or unsafe API URL is an error, never a quiet fallback. */
export function sourceFromEnv(
  env: WebEnv,
  sse: Pick<SseTransportOptions, 'applyResume' | 'fetch'> = {},
): SourceConfig {
  if (env.VITE_AFFIDAVIT_SOURCE !== 'live') return { mode: 'fake' };
  const baseUrl = env.VITE_AFFIDAVIT_API_URL;
  if (!baseUrl || !isSafeBaseUrl(baseUrl)) return { mode: 'config-error' };
  return { mode: 'live', transport: createSseTransport({ baseUrl, ...sse }) };
}

const EMPTY: StreamSnapshot = {
  events: [],
  status: 'connecting',
  invalidCount: 0,
  gapCount: 0,
  tooLong: false,
};

/** Runs one live stream for the lifetime of the component and exposes its snapshot. */
export function useTrialStream(
  caseId: string,
  transport: StreamTransport,
  backoff?: BackoffPolicy,
  maxEvents?: number,
) {
  const stream = useMemo(
    () =>
      createTrialStream({
        caseId,
        transport,
        ...(backoff ? { backoff } : {}),
        ...(maxEvents ? { maxEvents } : {}),
      }),
    [caseId, transport, backoff, maxEvents],
  );
  useEffect(() => {
    stream.start();
    return () => stream.stop();
  }, [stream]);
  const snapshot = useSyncExternalStore(stream.subscribe, stream.getSnapshot, () => EMPTY);
  return { snapshot, retry: stream.retry };
}
