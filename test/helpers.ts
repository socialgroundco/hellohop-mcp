import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { FetchLike } from '../src/client.js';
import type { Config } from '../src/config.js';
import { createServer } from '../src/server.js';

export const TOKEN = 'test-channel-token';

export function baseConfig(over: Partial<Config> = {}): Config {
  return {
    apiUrl: 'https://api.example.test/v1',
    token: TOKEN,
    channel: 'chan_1',
    allowSend: false,
    ...over,
  };
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

export interface Reply {
  status?: number;
  body?: unknown;
  // Sent as-is when set, instead of JSON.stringify(body).
  raw?: string;
  headers?: Record<string, string>;
}

// A fetch that records every call and answers from a queue (the last reply
// repeats). No network is ever touched.
export function fakeFetch(...replies: Reply[]): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = replies.length > 0 ? replies : [{ body: {} }];
  const fetch: FetchLike = async (input, init) => {
    calls.push({
      url: input,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    const reply = queue[Math.min(calls.length - 1, queue.length - 1)]!;
    const text = reply.raw ?? JSON.stringify(reply.body ?? {});
    return new Response(text, {
      status: reply.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...reply.headers },
    });
  };
  return { fetch, calls };
}

// Connect a real MCP Client to the server over the SDK's in-memory transport,
// so tools are exercised through the protocol.
export async function connect(config: Config, fetch: FetchLike): Promise<Client> {
  return connectServer(createServer(config, { fetch }));
}

export async function connectServer(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

export function textOf(result: unknown): string {
  const r = result as CallToolResult;
  const first = r.content[0];
  if (first === undefined || first.type !== 'text') {
    throw new Error(`expected a text content block, got ${JSON.stringify(r.content)}`);
  }
  return first.text;
}

// Decode the tool's text into an OBJECT and fail loudly otherwise: a JSON
// string or array would parse and still not be the shape under test.
export function objectOf(result: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(textOf(result));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`expected a JSON object, got ${textOf(result)}`);
  }
  return parsed as Record<string, unknown>;
}
