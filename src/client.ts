// A thin client for the public customer API.
//
// No retries, on purpose. A retried send is a second send, and pacing is the
// caller's decision. A 429 is reported with its retry_after and left there.
//
// Redirects are refused, never followed. Following one would replay a send's
// body at a location nobody approved, and a 302 would turn the POST into a GET
// whose 200 then reads as a successful send. The API never answers with one
// (the edge refuses to relay an upstream 3xx), so a redirect means something in
// between is rewriting the request.

import { ENV, type Config } from './config.js';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ApiSuccess {
  ok: true;
  status: number;
  body: Record<string, unknown>;
}

export interface ApiFailure {
  ok: false;
  // null when no response arrived (network error, timeout).
  status: number | null;
  // The API's stable error code, or null when the body did not carry one.
  code: string | null;
  error: string;
  retry_after?: number;
  window?: string;
  resets_at?: string;
  // Set by the API on a send it cannot confirm (504 send_unconfirmed): the
  // message may have been delivered. `id` is the row it logged for that send.
  // Both are passed through as fields; the id is never parsed out of `error`.
  ambiguous?: boolean;
  id?: string;
}

export type ApiResult = ApiSuccess | ApiFailure;

export const DEFAULT_TIMEOUT_MS = 30_000;

// The chat segment is sent LITERALLY, not percent-encoded.
//
// The public edge matches the RAW request path and refuses any path that
// contains `%` (internal/edge/policy.go opAllowed). encodeURIComponent would
// turn `123@s.whatsapp.net` into `123%40s.whatsapp.net`, which the edge
// refuses with a 404. So instead of encoding, this allows only characters that
// are legal in a path segment as they stand, and refuses everything else
// before any request is made. JIDs (`digits@s.whatsapp.net`, `id@g.us`,
// `digits@lid`, `user:device@server`) and phone numbers (`+15551234567`) fit.
const CHAT_SEGMENT_RE = /^[A-Za-z0-9@.:_+-]+$/;

export function chatSegmentProblem(chat: string): string | null {
  if (!CHAT_SEGMENT_RE.test(chat)) {
    return 'chat may contain only letters, digits and @ . : _ + -';
  }
  if (chat.includes('..') || chat === '.') {
    return 'chat must not be "." or contain ".."';
  }
  return null;
}

// A message id as the API takes one in a path: letters, digits and . _ -,
// starting with a letter or digit (so never "." or ".."), at most 128.
const MESSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function messageIdProblem(id: string): string | null {
  return MESSAGE_ID_RE.test(id)
    ? null
    : 'message_id must be 1 to 128 letters, digits and . _ -, starting with a letter or digit';
}

export class GatewayClient {
  constructor(
    private readonly config: Pick<Config, 'apiUrl' | 'token' | 'channel'>,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  // The URL for a path under this channel. Every segment passed here has
  // already been validated against a character set that needs no encoding.
  sessionUrl(...rest: string[]): string {
    return [this.config.apiUrl, 'sessions', this.config.channel, ...rest].join('/');
  }

  // Replace the token anywhere it appears. Applied to every string this client
  // hands back, success bodies included (see redactDeep), so an upstream that
  // echoes a credential cannot leak it here.
  redact(text: string): string {
    const token = this.config.token;
    return token === '' ? text : text.split(token).join('[redacted]');
  }

  // redact() over every string in a decoded body, keys as well as values. It
  // walks the decoded value rather than the raw text: a token containing `"` or
  // `\` appears ESCAPED in the raw JSON, so a text replace would miss it.
  redactDeep(value: unknown): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v));
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[this.redact(k)] = this.redactDeep(v);
      return out;
    }
    return value;
  }

  async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<ApiResult> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.token}`,
      Accept: 'application/json',
    };
    const init: RequestInit = {
      method,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(url, init);
      text = await res.text();
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      return {
        ok: false,
        status: null,
        code: null,
        error: this.redact(`request failed before a response arrived (${reason})`),
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }

    // Assert the SHAPE, not that it parses: a JSON string (for example a
    // quoted HTML page) is valid JSON and is not an API answer.
    // An ARRAY is not an answer either: every wrapped route documents an
    // object, so a 2xx `[]` means the base URL reached something adjacent.
    const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);

    if (res.ok) {
      if (isObject) {
        return {
          ok: true,
          status: res.status,
          body: this.redactDeep(parsed) as Record<string, unknown>,
        };
      }
      return {
        ok: false,
        status: res.status,
        code: null,
        error: `the response was not a JSON object; check that ${ENV.apiUrl} points at the API base`,
      };
    }

    const obj = isObject ? (parsed as Record<string, unknown>) : {};
    const failure: ApiFailure = {
      ok: false,
      status: res.status,
      code: typeof obj.code === 'string' ? this.redact(obj.code) : null,
      error:
        typeof obj.error === 'string'
          ? this.redact(obj.error)
          : `HTTP ${res.status} without the documented {code, error} body`,
    };
    const retryAfter = retryAfterSeconds(obj.retry_after, res.headers.get('Retry-After'));
    if (retryAfter !== undefined) failure.retry_after = retryAfter;
    if (typeof obj.window === 'string') failure.window = this.redact(obj.window);
    if (typeof obj.resets_at === 'string') failure.resets_at = this.redact(obj.resets_at);
    if (typeof obj.ambiguous === 'boolean') failure.ambiguous = obj.ambiguous;
    if (typeof obj.id === 'string') failure.id = this.redact(obj.id);
    return failure;
  }
}

// The body's retry_after wins; the Retry-After header (seconds) is the
// fallback. An HTTP-date header is not produced by this API and is ignored.
function retryAfterSeconds(fromBody: unknown, fromHeader: string | null): number | undefined {
  if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 0) {
    return fromBody;
  }
  if (fromHeader !== null && /^\d+$/.test(fromHeader.trim())) {
    return Number(fromHeader.trim());
  }
  return undefined;
}
