import {
  isNonRetryableStatus,
  NonRetryableStreamError,
  SAFE_CASE_ID,
  type StreamTransport,
} from './liveStream.js';

export const MAX_SSE_LINE_CHARS = 1024 * 1024;
export const MAX_SSE_MESSAGE_CHARS = 1024 * 1024;

export interface SseLimits {
  /** Longest single line, and longest unterminated buffer, in characters. */
  maxLine?: number;
  /** Longest assembled data field of one message, in characters. */
  maxMessage?: number;
}

/**
 * Splits an SSE byte stream into message data fields. Only `data:` lines are used; `id:`, `event:`
 * and comments are ignored, because the TrialEvent in the data field carries its own seq. A line
 * or message past the limits throws, which the stream treats as a dropped connection.
 */
export async function* sseMessages(
  body: AsyncIterable<Uint8Array>,
  limits: SseLimits = {},
): AsyncGenerator<string> {
  const maxLine = limits.maxLine ?? MAX_SSE_LINE_CHARS;
  const maxMessage = limits.maxMessage ?? MAX_SSE_MESSAGE_CHARS;
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let dataChars = 0;
  const flush = function* () {
    if (data.length > 0) yield data.join('\n');
    data = [];
    dataChars = 0;
  };
  // Pulls complete lines out of the buffer. A '\r' that ends the buffer may be the first half of
  // a '\r\n' split across chunks, so it waits for the next chunk (or the end of the stream).
  const lines = function* (final: boolean) {
    let nl: number;
    while ((nl = buffer.search(/\r\n|\n|\r/)) !== -1) {
      if (!final && nl === buffer.length - 1 && buffer[nl] === '\r') return;
      if (nl > maxLine) throw new Error('SSE line too long');
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + (buffer.startsWith('\r\n', nl) ? 2 : 1));
      if (line === '') yield* flush();
      else if (line.startsWith('data:')) {
        const value = line.slice(5).replace(/^ /, '');
        dataChars += value.length + 1;
        if (dataChars > maxMessage) throw new Error('SSE message too large');
        data.push(value);
      }
    }
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    yield* lines(false);
    if (buffer.length > maxLine) throw new Error('SSE line too long');
  }
  buffer += decoder.decode();
  yield* lines(true);
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
  limits?: SseLimits;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * https only, except localhost, 127.0.0.1 and [::1]; no credentials, query or fragment; and a
 * path that is '/' or a clean prefix with no empty segment. A path such as //evil.example.com
 * would otherwise be read as a host when joined onto the origin.
 */
export function isSafeBaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const local = LOCAL_HOSTS.has(url.hostname);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && local)) &&
      !url.pathname.includes('//')
    );
  } catch {
    return false;
  }
}

/** GET /cases/:id/events over fetch streaming. No cookies, no URL from content. */
export function createSseTransport(options: SseTransportOptions): StreamTransport {
  if (!isSafeBaseUrl(options.baseUrl)) throw new Error('Refused: unsafe API base URL');
  const base = new URL(options.baseUrl);
  const prefix = base.pathname.replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  return {
    async open(caseId, afterSeq, signal) {
      if (!SAFE_CASE_ID.test(caseId)) throw new Error('Refused: unsafe case id');
      // Set the path on a parsed URL so the host can only ever be the configured one.
      const url = new URL(base.origin);
      url.pathname = `${prefix}/cases/${encodeURIComponent(caseId)}/events`;
      const headers = new Headers({ Accept: 'text/event-stream' });
      if (afterSeq !== undefined) options.applyResume?.({ url, headers }, afterSeq);
      // Credentials are omitted until API auth is designed (L1-12).
      const res = await doFetch(url, { headers, signal, credentials: 'omit' });
      if (isNonRetryableStatus(res.status)) throw new NonRetryableStreamError(res.status);
      if (!res.ok || !res.body) throw new Error(`Event stream refused with status ${res.status}`);
      return sseMessages(chunks(res.body), options.limits);
    },
  };
}
