// Startup configuration: missing or unusable env fails clearly, and nothing
// written at startup ever contains the token.

import { BRAND } from '../src/brand.js';
import { describe, expect, it } from 'vitest';

import { ConfigError, ENV, loadConfig, LOOPBACK_HOSTS } from '../src/config.js';
import { startup } from '../src/startup.js';
import { connect, fakeFetch, TOKEN } from './helpers.js';

const GOOD = {
  [ENV.apiUrl]: 'https://api.example.test/v1',
  [ENV.token]: TOKEN,
  [ENV.channel]: 'chan_1',
};

function problemsFor(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  return [];
}

describe('loadConfig', () => {
  it('accepts a complete environment and normalises the base URL', () => {
    // Control: the GOOD fixture itself is valid, so every refusal below is
    // caused by the one field each case changes.
    expect(problemsFor(GOOD)).toEqual([]);
    const cfg = loadConfig({ ...GOOD, [ENV.apiUrl]: 'https://api.example.test/v1//' });
    expect(cfg).toEqual({ apiUrl: 'https://api.example.test/v1', token: TOKEN, channel: 'chan_1', allowSend: false });
  });

  for (const name of [ENV.token, ENV.channel]) {
    it(`fails when ${name} is missing or blank, naming it`, () => {
      for (const value of [undefined, '', '   ']) {
        const problems = problemsFor({ ...GOOD, [name]: value });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain(name);
      }
    });
  }

  it('reports every missing variable at once', () => {
    const problems = problemsFor({});
    expect(problems.join(' ')).not.toContain(ENV.apiUrl);
    expect(problems.join(' ')).toContain(ENV.token);
    expect(problems.join(' ')).toContain(ENV.channel);
  });

  it('requires https except on loopback', () => {
    expect(problemsFor({ ...GOOD, [ENV.apiUrl]: 'http://api.example.test/v1' })).toHaveLength(1);
    expect(problemsFor({ ...GOOD, [ENV.apiUrl]: 'ftp://api.example.test/v1' })).toHaveLength(1);
    expect(problemsFor({ ...GOOD, [ENV.apiUrl]: 'not a url' })).toHaveLength(1);
    expect(problemsFor({ ...GOOD, [ENV.apiUrl]: 'http://localhost:8080/v1' })).toEqual([]);
    expect(problemsFor({ ...GOOD, [ENV.apiUrl]: 'http://127.0.0.1:8080/v1' })).toEqual([]);
    expect(problemsFor({ ...GOOD, [ENV.apiUrl]: 'http://[::1]:8080/v1' })).toEqual([]);
  });

  it('plain http is accepted on exactly three loopback hosts, and 0.0.0.0 is not one', () => {
    expect([...LOOPBACK_HOSTS].sort()).toEqual(['127.0.0.1', '[::1]', 'localhost']);
    // Control: the same URL shape over https is fine, so each refusal is the
    // http-on-a-non-loopback-host rule.
    for (const host of ['0.0.0.0', '127.0.0.2', '10.0.0.1', 'localhost.example.test']) {
      expect(problemsFor({ ...GOOD, [ENV.apiUrl]: `https://${host}:8080/v1` }), host).toEqual([]);
      expect(problemsFor({ ...GOOD, [ENV.apiUrl]: `http://${host}:8080/v1` }), host).toHaveLength(1);
    }
  });

  it('trims surrounding whitespace from the token and keeps the rest exactly', () => {
    for (const raw of [` ${TOKEN}`, `${TOKEN}\n`, `\t ${TOKEN} \r\n`]) {
      expect(loadConfig({ ...GOOD, [ENV.token]: raw }).token, JSON.stringify(raw)).toBe(TOKEN);
    }
    // Case and inner characters are not touched.
    const mixed = 'Tok_AbC.def~123';
    expect(loadConfig({ ...GOOD, [ENV.token]: `  ${mixed}  ` }).token).toBe(mixed);
  });

  it('refuses a URL carrying credentials, a query or a fragment', () => {
    expect(problemsFor({ ...GOOD, [ENV.apiUrl]: 'https://user:pw@api.example.test/v1' })).toHaveLength(1);
    expect(problemsFor({ ...GOOD, [ENV.apiUrl]: 'https://api.example.test/v1?x=1' })).toHaveLength(1);
    expect(problemsFor({ ...GOOD, [ENV.apiUrl]: 'https://api.example.test/v1#x' })).toHaveLength(1);
  });

  it('refuses a channel outside the API channel segment', () => {
    for (const channel of ['a/b', 'a b', 'a%2f', '..', 'chan.1']) {
      expect(problemsFor({ ...GOOD, [ENV.channel]: channel }), channel).toHaveLength(1);
    }
  });

  it('never echoes the token, even when the token itself is the problem', () => {
    const badToken = `${TOKEN} with spaces`;
    let message = '';
    try {
      loadConfig({ ...GOOD, [ENV.token]: badToken, [ENV.apiUrl]: 'http://nope.example.test' });
    } catch (err) {
      message = String(err instanceof Error ? `${err.message} ${err.stack}` : err);
    }
    // Control: it did fail, for the token among other things.
    expect(message).toContain(ENV.token);
    expect(message).not.toContain(TOKEN);
  });
});

describe('startup', () => {
  it('fails clearly with missing env, logging the variable names and never the token', () => {
    const lines: string[] = [];
    const { fetch, calls } = fakeFetch();
    const server = startup({ [ENV.token]: TOKEN }, { log: (l) => lines.push(l), fetch });
    expect(server).toBeNull();
    const out = lines.join('\n');
    expect(out).toContain(ENV.apiUrl);
    expect(out).toContain(ENV.channel);
    expect(out).not.toContain(TOKEN);
    expect(calls).toHaveLength(0);
  });

  it('logs a ready line on success that states the send mode and never the token', () => {
    for (const [flag, mode] of [
      [undefined, 'disabled'],
      ['1', 'ENABLED'],
    ] as const) {
      const lines: string[] = [];
      const server = startup({ ...GOOD, [ENV.allowSend]: flag }, { log: (l) => lines.push(l) });
      expect(server).not.toBeNull();
      const out = lines.join('\n');
      expect(out).toContain(`sending ${mode}`);
      expect(out).toContain('chan_1');
      expect(out).not.toContain(TOKEN);
    }
  });

  it('logs the API origin only, never a path that may carry a credential', () => {
    const secretPath = 'k3y-in-path-0123456789';
    const lines: string[] = [];
    const server = startup(
      { ...GOOD, [ENV.apiUrl]: `https://api.example.test/${secretPath}/v1` },
      { log: (l) => lines.push(l) },
    );
    expect(server).not.toBeNull();
    const out = lines.join('\n');
    expect(out).toContain('https://api.example.test');
    expect(out).not.toContain(secretPath);
  });
});

describe('default API base', () => {
  it('an unset or blank GATEWAY_API_URL falls back to the public API', () => {
    const { [ENV.apiUrl]: _drop, ...rest } = GOOD;
    expect(loadConfig(rest).apiUrl).toBe(BRAND.publicApiUrl);
    expect(loadConfig({ ...rest, [ENV.apiUrl]: '  ' }).apiUrl).toBe(BRAND.publicApiUrl);
    expect(BRAND.publicApiUrl).toBe('https://api.hellohop.app/v1');
  });

  it('a custom GATEWAY_API_URL is used exactly as given (trailing slash trimmed)', () => {
    for (const pinned of ['https://api.example.test/v1', 'https://api.example.test/v1/']) {
      const cfg = loadConfig({ ...GOOD, [ENV.apiUrl]: pinned });
      expect(cfg.apiUrl).toBe('https://api.example.test/v1');
      expect(cfg.apiUrl).not.toBe(BRAND.publicApiUrl);
    }
  });

  it('the new host can be pinned explicitly and requests go to the pinned host', async () => {
    expect(loadConfig({ ...GOOD, [ENV.apiUrl]: 'https://api.hellohop.app/v1' }).apiUrl).toBe(BRAND.publicApiUrl);
    for (const pinned of ['https://api.example.test/v1', BRAND.publicApiUrl]) {
      const { fetch, calls } = fakeFetch();
      const client = await connect(loadConfig({ ...GOOD, [ENV.apiUrl]: pinned }), fetch);
      await client.callTool({ name: 'channel_status', arguments: {} });
      expect(calls.length).toBe(1);
      expect(String(calls[0]?.url).startsWith(pinned + '/sessions/')).toBe(true);
    }
  });
});
