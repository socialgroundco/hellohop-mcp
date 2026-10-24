// The widened tools (2026-10-05): five reads, and four sends behind the gate.

import { describe, expect, it } from 'vitest';

import { MEDIA_KINDS, READ_TOOLS, SEND_TOOLS } from '../src/server.js';
import { baseConfig, connect, fakeFetch, objectOf, TOKEN } from './helpers.js';

const BASE = 'https://api.example.test/v1/sessions/chan_1';

async function refused(client: Awaited<ReturnType<typeof connect>>, name: string, args: Record<string, unknown>) {
  let result: unknown;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch {
    return;
  }
  expect((result as { isError?: boolean }).isError, name).toBe(true);
}

describe('read tools', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['list_groups', {}, `${BASE}/groups`],
    ['get_group', { group: '120363000000000001@g.us' }, `${BASE}/groups/120363000000000001@g.us`],
    ['get_community', { community: '120363000000000002@g.us' }, `${BASE}/communities/120363000000000002@g.us`],
    ['list_community_subgroups', { community: '120363000000000002@g.us' }, `${BASE}/communities/120363000000000002@g.us/subgroups`],
    ['get_contact', { who: '15551234567@s.whatsapp.net' }, `${BASE}/contacts/15551234567@s.whatsapp.net`],
  ];
  for (const [name, args, url] of cases) {
    it(`${name} GETs ${url.slice(BASE.length)} literally, with the bearer, and returns the body`, async () => {
      expect(READ_TOOLS).toContain(name);
      const { fetch, calls } = fakeFetch({ body: { ok: name } });
      const client = await connect(baseConfig(), fetch);
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBeFalsy();
      expect(objectOf(result)).toEqual({ ok: name });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe('GET');
      expect(calls[0]!.url).toBe(url);
      expect(calls[0]!.url).not.toContain('%');
      expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(calls[0]!.body).toBeUndefined();
    });
  }
  it('a segment that cannot be sent literally is refused with zero requests', async () => {
    const { fetch, calls } = fakeFetch();
    const client = await connect(baseConfig(), fetch);
    for (const [name, args] of [
      ['get_group', { group: '../chats' }],
      ['get_group', { group: 'a/b' }],
      ['get_community', { community: '..' }],
      ['get_contact', { who: '15551234567%40s.whatsapp.net' }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
    expect(calls).toHaveLength(0);
    // CONTROL: the same client reaches the fetch with a good segment.
    await client.callTool({ name: 'get_group', arguments: { group: '1@g.us' } });
    expect(calls).toHaveLength(1);
  });
});

describe('the send gate covers every send tool', () => {
  it('when OFF none is listed, and calling each makes zero requests', async () => {
    const { fetch, calls } = fakeFetch({ body: { id: 'x' } });
    const client = await connect(baseConfig({ allowSend: false }), fetch);
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.callTool({ name: 'list_groups', arguments: {} });
    expect(calls).toHaveLength(1); // CONTROL: the harness is wired
    const args: Record<string, Record<string, unknown>> = {
      send_text: { to: '+15551234567', text: 'hi' },
      send_media: { kind: 'image', to: '+15551234567', url: 'https://example.com/a.png' },
      send_poll: { to: '+15551234567', question: 'Q?', options: ['a', 'b'] },
      react: { message_id: 'ABC', emoji: '👍' },
      unreact: { message_id: 'ABC' },
      delete_message: { message_id: 'ABC' },
    };
    for (const name of SEND_TOOLS) {
      expect(names, name).not.toContain(name);
      await refused(client, name, args[name]!);
    }
    expect(calls).toHaveLength(1);
  });
});

describe('send_media', () => {
  for (const kind of MEDIA_KINDS) {
    it(`POSTs ${kind} to messages/${kind} with only the fields given`, async () => {
      const ack = { id: 'M1', status: 'server_ack' };
      const { fetch, calls } = fakeFetch({ body: ack });
      const client = await connect(baseConfig({ allowSend: true }), fetch);
      const args: Record<string, unknown> = { kind, to: '+15551234567', url: 'https://example.com/f' };
      if (kind === 'document') Object.assign(args, { filename: 'f.pdf', mime_type: 'application/pdf', caption: 'c' });
      const result = await client.callTool({ name: 'send_media', arguments: args });
      expect(result.isError).toBeFalsy();
      expect(objectOf(result)).toEqual(ack);
      expect(calls[0]!.method).toBe('POST');
      expect(calls[0]!.url).toBe(`${BASE}/messages/${kind}`);
      const { kind: _k, ...want } = args;
      expect(JSON.parse(calls[0]!.body!)).toEqual(want);
    });
  }
  it('refuses a kind outside the five and a url that is not a URL, with zero requests', async () => {
    const { fetch, calls } = fakeFetch();
    const client = await connect(baseConfig({ allowSend: true }), fetch);
    await refused(client, 'send_media', { kind: 'sticker', to: '1', url: 'https://example.com/a' });
    await refused(client, 'send_media', { kind: 'image', to: '1', url: 'not a url' });
    expect(calls).toHaveLength(0);
  });
  it('a 502 media_upload_failed is a plain error (nothing sent); an edge 502 is delivery unknown', async () => {
    const { fetch } = fakeFetch(
      { status: 502, body: { code: 'media_upload_failed', error: 'nothing was sent' } },
      { status: 502, body: { code: 'upstream_unreachable', error: 'the gateway did not answer' } },
    );
    const client = await connect(baseConfig({ allowSend: true }), fetch);
    const args = { kind: 'image', to: '+15551234567', url: 'https://example.com/a.png' };
    const definite = objectOf(await client.callTool({ name: 'send_media', arguments: args }));
    expect(definite.code).toBe('media_upload_failed');
    expect(definite.delivery).toBeUndefined();
    const unknown = objectOf(await client.callTool({ name: 'send_media', arguments: args }));
    expect(unknown.delivery).toBe('unknown');
  });
  it('a 429 gateway_busy (media) keeps its retry_after', async () => {
    const { fetch } = fakeFetch({ status: 429, body: { code: 'gateway_busy', bound: 'media', retry_after: 10, error: 'busy' } });
    const client = await connect(baseConfig({ allowSend: true }), fetch);
    const r = objectOf(await client.callTool({ name: 'send_media', arguments: { kind: 'video', to: '1', url: 'https://example.com/v.mp4' } }));
    expect(r.retry_after).toBe(10);
    expect(r.delivery).toBeUndefined();
  });
});

describe('send_poll', () => {
  it('POSTs {to, question, options, multiple} to messages/poll', async () => {
    const { fetch, calls } = fakeFetch({ body: { id: 'P1', status: 'server_ack' } });
    const client = await connect(baseConfig({ allowSend: true }), fetch);
    const r = await client.callTool({ name: 'send_poll', arguments: { to: '1', question: 'Q?', options: ['a', 'b'], multiple: true } });
    expect(r.isError).toBeFalsy();
    expect(calls[0]!.url).toBe(`${BASE}/messages/poll`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ to: '1', question: 'Q?', options: ['a', 'b'], multiple: true });
  });
  it('refuses fewer than 2 or more than 12 options with zero requests', async () => {
    const { fetch, calls } = fakeFetch();
    const client = await connect(baseConfig({ allowSend: true }), fetch);
    await refused(client, 'send_poll', { to: '1', question: 'Q?', options: ['a'] });
    await refused(client, 'send_poll', { to: '1', question: 'Q?', options: Array.from({ length: 13 }, (_, i) => `o${i}`) });
    expect(calls).toHaveLength(0);
  });
  it('a 504 is delivery unknown, with no retry guidance', async () => {
    const { fetch, calls } = fakeFetch({ status: 504, body: { code: 'send_unconfirmed', ambiguous: true, id: 'ambiguous:1', error: 'x', retry_after: 5 } });
    const client = await connect(baseConfig({ allowSend: true }), fetch);
    const r = objectOf(await client.callTool({ name: 'send_poll', arguments: { to: '1', question: 'Q?', options: ['a', 'b'] } }));
    expect(r.delivery).toBe('unknown');
    expect(r.retry_after).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe('delete_message', () => {
  it('DELETEs messages/{id} with no body, and an already-revoked answer is a plain result', async () => {
    const { fetch, calls } = fakeFetch({ body: { message_id: '3EB0ABC', chat_jid: '1@s.whatsapp.net', status: 'already_revoked' } });
    const client = await connect(baseConfig({ allowSend: true }), fetch);
    const r = await client.callTool({ name: 'delete_message', arguments: { message_id: '3EB0ABC' } });
    expect(r.isError).toBeFalsy();
    expect(objectOf(r).status).toBe('already_revoked');
    expect(calls.map((c) => [c.method, c.url])).toEqual([['DELETE', `${BASE}/messages/3EB0ABC`]]);
    expect(calls[0]!.body).toBeUndefined();
  });
  it('refuses a message id that cannot be a path segment, with zero requests', async () => {
    const { fetch, calls } = fakeFetch();
    const client = await connect(baseConfig({ allowSend: true }), fetch);
    for (const id of ['..', '.', 'a/b', '%2e%2e', 'ambiguous:1', '-x', 'x'.repeat(129)]) {
      expect((await client.callTool({ name: 'delete_message', arguments: { message_id: id } })).isError, id).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
  it('a 403 not_own_message is a plain error, not delivery unknown', async () => {
    const fetch = async () => new Response(JSON.stringify({ code: 'not_own_message', error: 'not ours' }), { status: 403 });
    const client = await connect(baseConfig({ allowSend: true }), fetch);
    const r = objectOf(await client.callTool({ name: 'delete_message', arguments: { message_id: 'X1' } }));
    expect(r.code).toBe('not_own_message');
    expect(r.delivery).toBeUndefined();
  });
});

describe('react and unreact', () => {
  it('react PUTs {emoji} to messages/{id}/reaction; unreact DELETEs it with no body', async () => {
    const { fetch, calls } = fakeFetch({ body: { id: 'R1', status: 'server_ack' } });
    const client = await connect(baseConfig({ allowSend: true }), fetch);
    expect((await client.callTool({ name: 'react', arguments: { message_id: '3EB0ABC', emoji: '👍' } })).isError).toBeFalsy();
    expect((await client.callTool({ name: 'unreact', arguments: { message_id: '3EB0ABC' } })).isError).toBeFalsy();
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['PUT', `${BASE}/messages/3EB0ABC/reaction`],
      ['DELETE', `${BASE}/messages/3EB0ABC/reaction`],
    ]);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ emoji: '👍' });
    expect(calls[1]!.body).toBeUndefined();
  });
  it('refuses a message id that cannot be a path segment, with zero requests', async () => {
    const { fetch, calls } = fakeFetch();
    const client = await connect(baseConfig({ allowSend: true }), fetch);
    for (const id of ['..', '.', 'a/b', '%2e%2e', 'ambiguous:1', '-x', 'x'.repeat(129)]) {
      const r = await client.callTool({ name: 'react', arguments: { message_id: id, emoji: '👍' } });
      expect(r.isError, id).toBe(true);
      const u = await client.callTool({ name: 'unreact', arguments: { message_id: id } });
      expect(u.isError, id).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });
  it('a 404 message_not_found is a plain error; no response is delivery unknown', async () => {
    let n = 0;
    const fetch = async (input: string, init: RequestInit) => {
      n++;
      if (n === 1) return new Response(JSON.stringify({ code: 'message_not_found', error: 'no such message' }), { status: 404 });
      throw new TypeError('fetch failed');
    };
    const client = await connect(baseConfig({ allowSend: true }), fetch);
    const notFound = objectOf(await client.callTool({ name: 'react', arguments: { message_id: 'X1', emoji: '👍' } }));
    expect(notFound.code).toBe('message_not_found');
    expect(notFound.delivery).toBeUndefined();
    const gone = objectOf(await client.callTool({ name: 'unreact', arguments: { message_id: 'X1' } }));
    expect(gone.delivery).toBe('unknown');
  });
});
