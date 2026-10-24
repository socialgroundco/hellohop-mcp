// The send opt-in. Read-only is the default, and "off" means the tool does not
// exist: it is not listed, and calling it makes no HTTP request.

import { describe, expect, it } from 'vitest';

import { ENV } from '../src/config.js';
import { READ_TOOLS, SEND_TOOL, SEND_TOOLS } from '../src/server.js';
import { startup } from '../src/startup.js';
import { baseConfig, connect, connectServer, fakeFetch, objectOf, TOKEN } from './helpers.js';

async function toolNames(client: Awaited<ReturnType<typeof connect>>): Promise<string[]> {
  return (await client.listTools()).tools.map((t) => t.name).sort();
}

// Calling an unregistered tool may surface as a thrown protocol error or as an
// isError result depending on the SDK version. Either is a refusal; a success
// is not.
async function callExpectingRefusal(
  client: Awaited<ReturnType<typeof connect>>,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  let result: unknown;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch {
    return;
  }
  expect((result as { isError?: boolean }).isError).toBe(true);
}

describe('send opt-in gate', () => {
  it('when OFF: send_text is not listed, and calling it makes zero HTTP requests', async () => {
    const { fetch, calls } = fakeFetch({ body: { id: 'x', status: 'server_ack' } });
    const client = await connect(baseConfig({ allowSend: false }), fetch);

    expect(await toolNames(client)).toEqual([...READ_TOOLS].sort());
    expect(await toolNames(client)).not.toContain(SEND_TOOL);

    // POSITIVE CONTROL FIRST: the fake fetch is wired and a read reaches it,
    // so the zero below is a statement about send and not about the harness.
    await client.callTool({ name: 'list_chats', arguments: {} });
    expect(calls).toHaveLength(1);

    await callExpectingRefusal(client, SEND_TOOL, { to: '+15551234567', text: 'hello' });
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => c.method === 'POST' || c.url.includes('/messages/text'))).toBe(false);
  });

  it('when ON: send_text is listed and POSTs {to, text} to messages/text', async () => {
    const ack = { id: 'MSG1', chat_jid: '15551234567@s.whatsapp.net', timestamp: '2026-09-17T03:00:00Z', status: 'server_ack' };
    const { fetch, calls } = fakeFetch({ body: ack });
    const client = await connect(baseConfig({ allowSend: true }), fetch);

    expect(await toolNames(client)).toEqual([...READ_TOOLS, ...SEND_TOOLS].sort());

    const result = await client.callTool({ name: SEND_TOOL, arguments: { to: '+15551234567', text: 'hello' } });
    expect(result.isError).toBeFalsy();
    expect(objectOf(result)).toEqual(ack);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://api.example.test/v1/sessions/chan_1/messages/text');
    expect(call.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(call.body!)).toEqual({ to: '+15551234567', text: 'hello' });
  });

  it('when ON: quoted is passed through only when given', async () => {
    const { fetch, calls } = fakeFetch({ body: { id: 'MSG2', status: 'server_ack' } });
    const client = await connect(baseConfig({ allowSend: true }), fetch);
    await client.callTool({ name: SEND_TOOL, arguments: { to: '+15551234567', text: 'reply', quoted: 'ABC123' } });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ to: '+15551234567', text: 'reply', quoted: 'ABC123' });
  });

  // The env flag drives registration end to end, through startup.
  const flagCases: Array<[string | undefined, boolean]> = [
    ['1', true],
    ['true', true],
    [undefined, false],
    ['', false],
    ['0', false],
    ['false', false],
    ['yes', false],
    ['TRUE', false],
    [' 1', false],
    ['1 ', false],
  ];
  for (const [value, enabled] of flagCases) {
    it(`${ENV.allowSend}=${JSON.stringify(value)} -> send_text ${enabled ? 'listed' : 'absent'}`, async () => {
      const { fetch, calls } = fakeFetch();
      const env: Record<string, string | undefined> = {
        [ENV.apiUrl]: 'https://api.example.test/v1',
        [ENV.token]: TOKEN,
        [ENV.channel]: 'chan_1',
        [ENV.allowSend]: value,
      };
      const server = startup(env, { log: () => {}, fetch });
      expect(server).not.toBeNull();
      const client = await connectServer(server!);
      for (const name of SEND_TOOLS) expect((await toolNames(client)).includes(name), name).toBe(enabled);
      expect(calls).toHaveLength(0);
    });
  }
});
