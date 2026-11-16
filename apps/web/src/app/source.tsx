import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  createTrialStream,
  type BackoffPolicy,
  type StreamSnapshot,
  type StreamTransport,
} from '../model/liveStream.js';
import { createSseTransport, type SseTransportOptions } from '../model/sseTransport.js';

/**
 * Where case pages get their events. `fake` replays the recorded fixtures (the default, and what
 * the corpus list uses). `live` streams GET /cases/:id/events from the API.
 */
export type SourceConfig =
  { mode: 'fake' } | { mode: 'live'; transport: StreamTransport; backoff?: BackoffPolicy };

const SourceContext = createContext<SourceConfig>({ mode: 'fake' });
export const SourceProvider = SourceContext.Provider;
export const useSourceConfig = (): SourceConfig => useContext(SourceContext);

/** Env values as Vite exposes them. All optional; a bad value falls back to fake. */
export interface WebEnv {
  VITE_AFFIDAVIT_SOURCE?: string | undefined;
  VITE_AFFIDAVIT_API_URL?: string | undefined;
}

/** https only, except localhost and 127.0.0.1; no credentials, query or fragment. */
export function isSafeBaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && local))
    );
  } catch {
    return false;
  }
}

export function sourceFromEnv(
  env: WebEnv,
  sse: Pick<SseTransportOptions, 'applyResume' | 'fetch'> = {},
): SourceConfig {
  if (env.VITE_AFFIDAVIT_SOURCE !== 'live') return { mode: 'fake' };
  const baseUrl = env.VITE_AFFIDAVIT_API_URL;
  if (!baseUrl || !isSafeBaseUrl(baseUrl)) return { mode: 'fake' };
  return { mode: 'live', transport: createSseTransport({ baseUrl, ...sse }) };
}

const EMPTY: StreamSnapshot = { events: [], status: 'connecting', invalidCount: 0, gapCount: 0 };

/** Runs one live stream for the lifetime of the component and exposes its snapshot. */
export function useTrialStream(
  caseId: string,
  transport: StreamTransport,
  backoff?: BackoffPolicy,
) {
  const stream = useMemo(
    () => createTrialStream({ caseId, transport, ...(backoff ? { backoff } : {}) }),
    [caseId, transport, backoff],
  );
  useEffect(() => {
    stream.start();
    return () => stream.stop();
  }, [stream]);
  const snapshot = useSyncExternalStore(stream.subscribe, stream.getSnapshot, () => EMPTY);
  return { snapshot, retry: stream.retry };
}
