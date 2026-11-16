import { SAFE_CASE_ID, type StreamTransport } from './liveStream.js';

/**
 * Splits an SSE byte stream into message data fields. Only `data:` lines are used; `id:`, `event:`
 * and comments are ignored, because the TrialEvent in the data field carries its own seq.
 */
export async function* sseMessages(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  const flush = function* () {
    if (data.length > 0) yield data.join('\n');
    data = [];
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.search(/\r\n|\n|\r/)) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + (buffer.startsWith('\r\n', nl) ? 2 : 1));
      if (line === '') yield* flush();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  }
}

async function* chunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export interface ResumeRequest {
  url: URL;
  headers: Headers;
}

export interface SseTransportOptions {
  /** API origin from config, for example http://localhost:3000. Never taken from case content. */
  baseUrl: string;
  /**
   * How to tell the server which seq to resume after. Contracts v1.0 says only that SSE resumes
   * from the last seq seen, not whether that is a Last-Event-ID header or a query parameter, so
   * there is no default. Without it every reconnect replays from the start and the client drops
   * the seqs it already has (see CR-T10).
   */
  applyResume?: (request: ResumeRequest, afterSeq: number) => void;
  fetch?: typeof fetch;
}

/** GET /cases/:id/events over fetch streaming. Same-origin credentials, no URL from content. */
export function createSseTransport(options: SseTransportOptions): StreamTransport {
  const base = new URL(options.baseUrl);
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  return {
    async open(caseId, afterSeq, signal) {
      if (!SAFE_CASE_ID.test(caseId)) throw new Error('Refused: unsafe case id');
      const path = `${base.pathname.replace(/\/+$/, '')}/cases/${encodeURIComponent(caseId)}/events`;
      const url = new URL(path, base.origin);
      const headers = new Headers({ Accept: 'text/event-stream' });
      if (afterSeq !== undefined) options.applyResume?.({ url, headers }, afterSeq);
      const res = await doFetch(url, { headers, signal, credentials: 'include' });
      if (!res.ok || !res.body) throw new Error(`Event stream refused with status ${res.status}`);
      return sseMessages(chunks(res.body));
    },
  };
}
