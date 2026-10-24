// The read tools and error mapping, exercised through the MCP protocol over the
// SDK's in-memory transport, against a recorded fake fetch.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import type { FetchLike } from '../src/client.js';
import { createServer, READ_TOOLS, SEND_TOOL, SEND_TOOLS } from '../src/server.js';
import { baseConfig, connect, connectServer, fakeFetch, objectOf, textOf, TOKEN } from './helpers.js';

const BASE = 'https://api.example.test/v1/sessions/chan_1';

function expectReadRequest(call: { method: string; url: string; headers: Headers; body: string | undefined }, url: string) {
  expect(call.method).toBe('GET');
  expect(call.url).toBe(url);
  expect(call.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  expect(call.headers.get('accept')).toBe('application/json');
  expect(call.headers.get('content-type')).toBeNull();
  expect(call.body).toBeUndefined();
}

describe('list_chats', () => {
  it('GETs {base}/sessions/{channel}/chats with the bearer, no query string, and returns the body', async () => {
    const body = { chats: [{ jid: '15551234567@s.whatsapp.net' }], source: 'log' };
    const { fetch, calls } = fakeFetch({ body });
    const client = await connect(baseConfig(), fetch);
    const result = await client.callTool({ name: 'list_chats', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(objectOf(result)).toEqual(body);
    expect(calls).toHaveLength(1);
    // The edge drops query strings (internal/edge/passthrough.go relay), so
    // none is sent: a `limit` here would look honoured and never be.
    expectReadRequest(calls[0]!, `${BASE}/chats`);
  });
});

describe('channel_status', () => {
  it('GETs {base}/sessions/{channel} only, by default', async () => {
    const body = { name: 'chan_1', state: 'connected' };
    const { fetch, calls } = fakeFetch({ body });
    const client = await connect(baseConfig(), fetch);
    const result = await client.callTool({ name: 'channel_status', arguments: {} });
    expect(objectOf(result)).toEqual(body);
    expect(calls).toHaveLength(1);
    expectReadRequest(calls[0]!, BASE);
  });

  it('with include_safety, also GETs /safety and returns both, all GETs', async () => {
    const session = { name: 'chan_1', state: 'connected' };
    const safety = { overall: 'good', indicators: [] };
    const { fetch, calls } = fakeFetch({ body: session }, { body: safety });
    const client = await connect(baseConfig(), fetch);
    const result = await client.callTool({ name: 'channel_status', arguments: { include_safety: true } });
    expect(objectOf(result)).toEqual({ session, safety });
    expect(calls).toHaveLength(2);
    expectReadRequest(calls[0]!, BASE);
    expectReadRequest(calls[1]!, `${BASE}/safety`);
  });
});

describe('read_messages', () => {
  it('sends the chat JID LITERALLY in the path: `@` unencoded, no `%` anywhere', async () => {
    // The public edge matches the raw path and refuses any `%`
    // (internal/edge/policy.go opAllowed), so encodeURIComponent's
    // `15551234567%40s.whatsapp.net` would be a 404 there.
    const body = { messages: [{ id: 'M1', text: 'hi' }], source: 'log' };
    const { fetch, calls } = fakeFetch({ body });
    const client = await connect(baseConfig(), fetch);
    for (const chat of ['15551234567@s.whatsapp.net', '120363000000000000@g.us', '123456789@lid', '+15551234567']) {
      const result = await client.callTool({ name: 'read_messages', arguments: { chat } });
      expect(result.isError).toBeFalsy();
      expect(objectOf(result)).toEqual(body);
    }
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/chats/15551234567@s.whatsapp.net/messages`,
      `${BASE}/chats/120363000000000000@g.us/messages`,
      `${BASE}/chats/123456789@lid/messages`,
      `${BASE}/chats/+15551234567/messages`,
    ]);
    for (const c of calls) {
      expectReadRequest(c, c.url);
      expect(c.url).not.toContain('%');
      expect(c.url).not.toContain('?');
    }
  });

  it('pages: limit and before go in the query, validated before any request', async () => {
    const body = { messages: [], chats: ['15551234567@s.whatsapp.net'], merge: 'none_known', next_before: 'MTox' };
    const { fetch, calls } = fakeFetch({ body });
    const client = await connect(baseConfig(), fetch);
    const chat = '15551234567@s.whatsapp.net';
    const result = await client.callTool({ name: 'read_messages', arguments: { chat, limit: 200, before: 'MToxNzU5OkEx' } });
    expect(result.isError).toBeFalsy();
    expect(objectOf(result)).toEqual(body);
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/chats/${chat}/messages?limit=200&before=MToxNzU5OkEx`]);
    for (const bad of [{ limit: 0 }, { limit: 501 }, { limit: 1.5 }, { before: 'a+b' }, { before: '' }]) {
      const r = await client.callTool({ name: 'read_messages', arguments: { chat, ...bad } });
      expect(r.isError, JSON.stringify(bad)).toBe(true);
    }
    expect(calls).toHaveLength(1);
  });

  it('refuses a chat that cannot be sent literally, with zero HTTP requests', async () => {
    const { fetch, calls } = fakeFetch({ body: { messages: [] } });
    const client = await connect(baseConfig(), fetch);

    // Control first: a valid chat reaches fetch.
    await client.callTool({ name: 'read_messages', arguments: { chat: '15551234567@s.whatsapp.net' } });
    expect(calls).toHaveLength(1);

    for (const chat of ['a/b', '15551234567%40s.whatsapp.net', '..', '.', 'a..b', 'a b', 'a?b', 'a#b', 'xé@s.whatsapp.net']) {
      const result = await client.callTool({ name: 'read_messages', arguments: { chat } });
      expect(result.isError, `chat ${JSON.stringify(chat)}`).toBe(true);
      expect(typeof objectOf(result).error).toBe('string');
    }
    expect(calls).toHaveLength(1);
  });
});

describe('error mapping', () => {
  it('401 is an MCP tool error carrying status, code and error', async () => {
    const { fetch } = fakeFetch({ status: 401, body: { code: 'unauthorized', error: 'missing bearer token' } });
    const client = await connect(baseConfig(), fetch);
    const result = await client.callTool({ name: 'list_chats', arguments: {} });
    expect(result.isError).toBe(true);
    const details = objectOf(result);
    expect(details.status).toBe(401);
    expect(details.code).toBe('unauthorized');
    expect(details.error).toBe('missing bearer token');
    expect(details).not.toHaveProperty('retry_after');
  });

  it('429 carries retry_after from the body, and is NOT retried', async () => {
    const { fetch, calls } = fakeFetch({
      status: 429,
      headers: { 'Retry-After': '2' },
      body: { code: 'rate_limited', error: 'too many requests', window: 'token.read', retry_after: 2 },
    });
    const client = await connect(baseConfig(), fetch);
    const result = await client.callTool({ name: 'channel_status', arguments: {} });
    expect(result.isError).toBe(true);
    const details = objectOf(result);
    expect(details.status).toBe(429);
    expect(details.code).toBe('rate_limited');
    expect(details.retry_after).toBe(2);
    expect(details.window).toBe('token.read');
    expect(calls).toHaveLength(1);
  });

  it('429 with retry_after only in the Retry-After header still reports it', async () => {
    const { fetch } = fakeFetch({
      status: 429,
      headers: { 'Retry-After': '7' },
      body: { code: 'rate_limited', error: 'too many requests' },
    });
    const client = await connect(baseConfig(), fetch);
    const details = objectOf(await client.callTool({ name: 'list_chats', arguments: {} }));
    expect(details.retry_after).toBe(7);
  });

  it('daily send cap: retry_after and resets_at are passed through, not retried', async () => {
    const { fetch, calls } = fakeFetch({
      status: 429,
      body: {
        code: 'daily_send_cap_exceeded',
        error: 'daily cap',
        window: 'daily_send',
        retry_after: 3600,
        resets_at: '2026-09-18T00:00:00+07:00',
      },
    });
    const client = await connect(baseConfig({ allowSend: true }), fetch);
    const result = await client.callTool({ name: 'send_text', arguments: { to: '+15551234567', text: 'x' } });
    expect(result.isError).toBe(true);
    const details = objectOf(result);
    expect(details.code).toBe('daily_send_cap_exceeded');
    expect(details.retry_after).toBe(3600);
    expect(details.resets_at).toBe('2026-09-18T00:00:00+07:00');
    expect(calls).toHaveLength(1);
  });

  it('a 200 whose body is not a JSON object is an error, not a success', async () => {
    // Control first: an object body is a success.
    const good = fakeFetch({ body: { chats: [] } });
    const goodClient = await connect(baseConfig(), good.fetch);
    expect((await goodClient.callTool({ name: 'list_chats', arguments: {} })).isError).toBeFalsy();

    for (const raw of ['"<html>console</html>"', '<html>console</html>', '', 'null', '42', '[]', '[{"chats":[]}]']) {
      const { fetch } = fakeFetch({ raw });
      const client = await connect(baseConfig(), fetch);
      const result = await client.callTool({ name: 'list_chats', arguments: {} });
      expect(result.isError, `body ${JSON.stringify(raw)}`).toBe(true);
      expect(objectOf(result).status).toBe(200);
    }
  });

  it('an error body without the documented shape still reports the status', async () => {
    const { fetch } = fakeFetch({ status: 502, raw: '<html>bad gateway</html>' });
    const client = await connect(baseConfig(), fetch);
    const result = await client.callTool({ name: 'list_chats', arguments: {} });
    expect(result.isError).toBe(true);
    const details = objectOf(result);
    expect(details.status).toBe(502);
    expect(details.code).toBeNull();
    expect(typeof details.error).toBe('string');
  });

  it('a send with no response says delivery is unknown, and is sent exactly once', async () => {
    // Counted, because this is the path where a retry is most tempting and
    // most dangerous: a send that failed without a response may have landed.
    let fetchCalls = 0;
    const fetch = async (): Promise<Response> => {
      fetchCalls++;
      throw new TypeError('fetch failed');
    };
    const client = await connect(baseConfig({ allowSend: true }), fetch);
    const result = await client.callTool({ name: 'send_text', arguments: { to: '+15551234567', text: 'x' } });
    expect(result.isError).toBe(true);
    const details = objectOf(result);
    expect(details.status).toBeNull();
    expect(details.delivery).toBe('unknown');
    expect(fetchCalls).toBe(1);
  });
});

describe('the token never leaves in output', () => {
  it('is redacted from an upstream error body that echoes it', async () => {
    const { fetch } = fakeFetch({ status: 401, body: { code: 'unauthorized', error: `token ${TOKEN} is not valid` } });
    const client = await connect(baseConfig(), fetch);
    const result = await client.callTool({ name: 'list_chats', arguments: {} });
    // Control: the fixture did put the token in the body, and the error came
    // through (so absence below is redaction, not a dropped message).
    expect(objectOf(result).error).toBe('token [redacted] is not valid');
    expect(textOf(result)).not.toContain(TOKEN);
  });

  it('is redacted from a fetch exception message', async () => {
    const fetch = async (): Promise<Response> => {
      throw new Error(`connect failed for Bearer ${TOKEN}`);
    };
    const client = await connect(baseConfig(), fetch);
    const result = await client.callTool({ name: 'channel_status', arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[redacted]');
    expect(textOf(result)).not.toContain(TOKEN);
  });
});

describe('the token never leaves in output (continued)', () => {
  it('is redacted from code, window and id in an error body', async () => {
    const { fetch } = fakeFetch({
      status: 429,
      body: { code: `c_${TOKEN}`, error: 'e', window: `w_${TOKEN}`, id: `i_${TOKEN}`, retry_after: 1 },
    });
    const client = await connect(baseConfig(), fetch);
    const result = await client.callTool({ name: 'list_chats', arguments: {} });
    const details = objectOf(result);
    // Control: each field came through, so absence of the token is redaction.
    expect(details.code).toBe('c_[redacted]');
    expect(details.window).toBe('w_[redacted]');
    expect(details.id).toBe('i_[redacted]');
    expect(textOf(result)).not.toContain(TOKEN);
  });

  it('is redacted from a SUCCESS body, in values and keys, at any depth', async () => {
    const body = { chats: [{ name: `hi ${TOKEN}`, nested: { [`k_${TOKEN}`]: [TOKEN] } }], n: 1, ok: true, none: null };
    const { fetch } = fakeFetch({ body });
    const client = await connect(baseConfig(), fetch);
    const result = await client.callTool({ name: 'list_chats', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(objectOf(result)).toEqual({
      chats: [{ name: 'hi [redacted]', nested: { 'k_[redacted]': ['[redacted]'] } }],
      n: 1,
      ok: true,
      none: null,
    });
    expect(textOf(result)).not.toContain(TOKEN);
  });

  it('is redacted from a success body even when JSON escapes it (a token with " and \\)', async () => {
    const token = 'tok"quote\\slash_9f';
    const { fetch } = fakeFetch({ body: { echo: `bearer ${token}` } });
    const client = await connect(baseConfig({ token }), fetch);
    const result = await client.callTool({ name: 'list_chats', arguments: {} });
    expect(objectOf(result)).toEqual({ echo: 'bearer [redacted]' });
  });
});

describe('tool annotations', () => {
  it('read tools are read-only and idempotent; every send tool is neither', async () => {
    const { fetch } = fakeFetch();
    const client = await connect(baseConfig({ allowSend: true }), fetch);
    const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t.annotations]));
    // Control: every tool this test speaks for is listed.
    expect([...tools.keys()].sort()).toEqual([...READ_TOOLS, ...SEND_TOOLS].sort());
    for (const name of READ_TOOLS) {
      const a = tools.get(name);
      expect(a?.readOnlyHint, name).toBe(true);
      expect(a?.destructiveHint, name).toBe(false);
      expect(a?.idempotentHint, name).toBe(true);
    }
    // Some clients may auto-approve a readOnlyHint tool. A send must never
    // look like one, nor like something safe to repeat.
    expect(SEND_TOOLS).toContain(SEND_TOOL);
    for (const name of SEND_TOOLS) {
      const send = tools.get(name);
      expect(send?.readOnlyHint, name).toBe(false);
      expect(send?.idempotentHint, name).toBe(false);
    }
  });
});

describe('request hardening', () => {
  it('a request that never answers is aborted by the timeout and reported with no status', async () => {
    let sawSignal = false;
    const fetch: FetchLike = (_url, init) => {
      const signal = init.signal;
      // Without a signal this fetch ANSWERS, so a missing timeout reads as a
      // success below, not as a hang.
      if (!signal) return Promise.resolve(new Response('{"chats":[]}', { status: 200 }));
      sawSignal = true;
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    const client = await connectServer(createServer(baseConfig(), { fetch, timeoutMs: 20 }));
    const result = await client.callTool({ name: 'list_chats', arguments: {} });
    expect(sawSignal).toBe(true);
    expect(result.isError).toBe(true);
    const details = objectOf(result);
    expect(details.status).toBeNull();
    expect(String(details.error)).toContain('TimeoutError');
  });

  // A REAL loopback server and the REAL fetch, because the property is how
  // fetch treats a redirect, and a fake fetch would only assert its own input.
  it('a redirect is refused, never followed: a 302 on a send does not become a GET that reads as sent', async () => {
    const hits: string[] = [];
    const srv = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
      hits.push(`${req.method} ${req.url}`);
      if (req.url === '/v1/sessions/chan_1/messages/text') {
        res.writeHead(302, { Location: '/elsewhere' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"id":"MSG1","status":"server_ack"}');
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    try {
      const port = (srv.address() as AddressInfo).port;
      const cfg = baseConfig({ apiUrl: `http://127.0.0.1:${port}/v1`, allowSend: true });
      const client = await connectServer(createServer(cfg));
      const result = await client.callTool({ name: SEND_TOOL, arguments: { to: '+15551234567', text: 'x' } });
      // Control: the request did reach the server's send path.
      expect(hits[0]).toBe('POST /v1/sessions/chan_1/messages/text');
      expect(hits).toHaveLength(1);
      expect(result.isError).toBe(true);
      const details = objectOf(result);
      expect(details.status).toBeNull();
      expect(details.delivery).toBe('unknown');
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});
