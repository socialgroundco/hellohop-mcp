// Configuration from the environment.
//
// Every error message names the variable and never echoes a value: the token
// must never reach a log, and a URL can carry credentials.

import { BRAND } from './brand.js';

export const ENV = {
  apiUrl: 'GATEWAY_API_URL',
  token: 'GATEWAY_API_TOKEN',
  channel: 'GATEWAY_CHANNEL_ID',
  allowSend: 'GATEWAY_ALLOW_SEND',
} as const;

export interface Config {
  // Normalised: origin plus path, no trailing slash, for example
  // https://api.hellohop.app/v1
  apiUrl: string;
  token: string;
  channel: string;
  // True only when GATEWAY_ALLOW_SEND is exactly "1" or "true".
  allowSend: boolean;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`configuration error: ${problems.join('; ')}`);
    this.name = 'ConfigError';
  }
}

// Mirrors the public API's channel segment (`[A-Za-z0-9_-]+`). A channel
// outside it could never match a route, and would otherwise be spliced raw
// into a URL path.
const CHANNEL_RE = /^[A-Za-z0-9_-]+$/;

// A bearer token is sent in a header, so it must be visible ASCII with no
// whitespace. Checked here so a bad value fails at startup with a message that
// does not contain it, rather than inside fetch.
const TOKEN_RE = /^[\x21-\x7e]+$/;

// Exactly these three, the only hosts where plain http is accepted. `0.0.0.0`
// is not one: it means "any address", and what a connection to it reaches
// depends on the platform. Pinned by test/config.test.ts.
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

// The send opt-in. Anything other than these exact strings is off.
const SEND_OPT_IN = new Set(['1', 'true']);

export function parseAllowSend(raw: string | undefined): boolean {
  return raw !== undefined && SEND_OPT_IN.has(raw);
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const problems: string[] = [];

  const rawUrl = (env[ENV.apiUrl] ?? '').trim() || BRAND.publicApiUrl;
  let apiUrl = '';
  let parsed: URL | undefined;
  try {
    parsed = new URL(rawUrl);
  } catch {
    problems.push(`${ENV.apiUrl} is not a valid URL`);
  }
  if (parsed) {
    const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
      problems.push(`${ENV.apiUrl} must use https (plain http is accepted only for localhost)`);
    } else if (parsed.username !== '' || parsed.password !== '') {
      problems.push(`${ENV.apiUrl} must not contain credentials; put the token in ${ENV.token}`);
    } else if (parsed.search !== '' || parsed.hash !== '') {
      problems.push(`${ENV.apiUrl} must not contain a query string or fragment`);
    } else {
      apiUrl = parsed.origin + parsed.pathname.replace(/\/+$/, '');
    }
  }

  const token = (env[ENV.token] ?? '').trim();
  if (token === '') {
    problems.push(`${ENV.token} is not set`);
  } else if (!TOKEN_RE.test(token)) {
    problems.push(`${ENV.token} contains characters that cannot be sent in a header`);
  }

  const channel = (env[ENV.channel] ?? '').trim();
  if (channel === '') {
    problems.push(`${ENV.channel} is not set`);
  } else if (!CHANNEL_RE.test(channel)) {
    problems.push(`${ENV.channel} may contain only letters, digits, "_" and "-"`);
  }

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
  return { apiUrl, token, channel, allowSend: parseAllowSend(env[ENV.allowSend]) };
}
