// D484: the check_numbers tool, through the MCP protocol against a recorded fake fetch.

import { describe, expect, it } from 'vitest';

import { CHECK_MAX_NUMBERS, CHECK_TOOLS } from '../src/server.js';
import { baseConfig, connect, fakeFetch, objectOf, TOKEN } from './helpers.js';

const BASE = 'https://api.example.test/v1/sessions/chan_1';
const JOB = 'nck_0123456789abcdef01234567';
const accuracy = 'A check is a point-in-time answer and can be wrong or out of date; it is not a guarantee that a message will be delivered.';

const job = {
  id: JOB,
  channel: 'chan_1',
  state: 'running',
  total: 2,
  done: 0,
  invalid: 0,
  live_lookups: 0,
  cached_hits: 0,
  created_at: '2026-10-24T03:00:00Z',
  updated_at: '2026-10-24T03:00:00Z',
};

describe('check_numbers', () => {
  it('is listed without the send gate, is not a read-only tool and says what a check is worth', async () => {
    const { fetch } = fakeFetch();
    const client = await connect(baseConfig({ allowSend: false }), fetch);
    const tool = (await client.listTools()).tools.find((t) => t.name === CHECK_TOOLS[0]);
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(false);
    const d = tool?.description ?? '';
    // The accuracy caveat, account eligibility and result fields travel in the description.
    for (const phrase of [
      'point-in-time',
      'not a guarantee',
      'included with every paid number',
      'spaced out',
      'no way to make a check faster',
      'lid',
      'phone_e164',
      'never "personal"',
      'number_checker_requires_paid_number',
      'number_checker_requires_non_sandbox_channel',
    ]) {
      expect(d, phrase).toContain(phrase);
    }
  });

  it('creates a job: POSTs {numbers, refresh} to number-checks with the bearer and returns the job', async () => {
    const { fetch, calls } = fakeFetch({ status: 201, body: job });
    const client = await connect(baseConfig(), fetch);
    const result = await client.callTool({
      name: 'check_numbers',
      arguments: { numbers: ['+66 90 000 0000', '(202) 555-0123'], refresh: true },
    });
    expect(result.isError).toBeFalsy();
    expect(objectOf(result)).toEqual({ ...job, accuracy });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(`${BASE}/number-checks`);
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ numbers: ['+66 90 000 0000', '(202) 555-0123'], refresh: true });
  });

  it('sends no refresh unless asked, and refuses more than the per-call cap without a request', async () => {
    const { fetch, calls } = fakeFetch({ status: 201, body: job });
    const client = await connect(baseConfig(), fetch);
    await client.callTool({ name: 'check_numbers', arguments: { numbers: ['+66900000000'] } });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ numbers: ['+66900000000'] });
    const tooMany = Array.from({ length: CHECK_MAX_NUMBERS + 1 }, (_, i) => `+6690000${String(1000 + i)}`);
    for (const args of [{ numbers: tooMany }, { numbers: [] }, { numbers: [''] }]) {
      const r = await client.callTool({ name: 'check_numbers', arguments: args }).catch(() => ({ isError: true }));
      expect((r as { isError?: boolean }).isError, JSON.stringify(args).slice(0, 40)).toBe(true);
    }
    expect(calls).toHaveLength(1);
  });

  it('reads a job: GETs the job and a page of rows (with the additive fields), merged', async () => {
    const results = {
      results: [
        {
          input: '+66 90 000 0000',
          phone_e164: '+66900000000',
          country: 'TH',
          status: 'registered',
          registered: true,
          jid: '66900000000@s.whatsapp.net',
          lid: '100000000000000@lid',
          is_business: true,
          verified_name: 'Example Shop',
          checked_at: '2026-10-24T03:01:00Z',
          cached: true,
          age_seconds: 3600,
        },
        { input: 'abc', status: 'invalid', registered: false, error: 'contains characters that are not part of a phone number' },
      ],
      total: 2,
    };
    const { fetch, calls } = fakeFetch({ body: job }, { body: results });
    const client = await connect(baseConfig(), fetch);
    const r = await client.callTool({
      name: 'check_numbers',
      arguments: { job_id: JOB, offset: 0, limit: 100, status: ['registered', 'invalid', 'registered'] },
    });
    expect(r.isError).toBeFalsy();
    expect(objectOf(r)).toEqual({ job, results: results.results, total: 2, accuracy });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', `${BASE}/number-checks/${JOB}`],
      ['GET', `${BASE}/number-checks/${JOB}/results?offset=0&limit=100&status=registered%2Cinvalid`],
    ]);
    expect(calls[1]!.body).toBeUndefined();
  });

  it('a read without paging sends no query', async () => {
    const { fetch, calls } = fakeFetch({ body: job }, { body: { results: [], total: 0 } });
    const client = await connect(baseConfig(), fetch);
    await client.callTool({ name: 'check_numbers', arguments: { job_id: JOB } });
    expect(calls[1]!.url).toBe(`${BASE}/number-checks/${JOB}/results`);
  });

  it('needs exactly one of numbers and job_id, and a well-formed job id, before any request', async () => {
    const { fetch, calls } = fakeFetch({ body: job });
    const client = await connect(baseConfig(), fetch);
    const both = await client.callTool({ name: 'check_numbers', arguments: { numbers: ['+66900000000'], job_id: JOB } });
    const neither = await client.callTool({ name: 'check_numbers', arguments: {} });
    expect(both.isError).toBe(true);
    expect(neither.isError).toBe(true);
    for (const bad of ['nck_', '../x', 'nck_0123456789abcdef0123456', `${JOB}/cancel`, 'nck_0123456789ABCDEF01234567']) {
      const r = await client.callTool({ name: 'check_numbers', arguments: { job_id: bad } }).catch(() => ({ isError: true }));
      expect((r as { isError?: boolean }).isError, bad).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it('an API refusal comes back as an error with its code, and a failed job read makes no results request', async () => {
    const { fetch, calls } = fakeFetch({ status: 404, body: { code: 'not_found', error: 'not found' } });
    const client = await connect(baseConfig(), fetch);
    const r = await client.callTool({ name: 'check_numbers', arguments: { job_id: JOB } });
    expect(r.isError).toBe(true);
    expect(objectOf(r)).toMatchObject({ status: 404, code: 'not_found' });
    expect(calls).toHaveLength(1);
    const { fetch: f2 } = fakeFetch({ status: 409, body: { code: 'whatsapp_disconnected', error: 'not connected' } });
    const c2 = await connect(baseConfig(), f2);
    const r2 = await c2.callTool({ name: 'check_numbers', arguments: { numbers: ['+66900000000'] } });
    expect(r2.isError).toBe(true);
    expect(objectOf(r2)).toMatchObject({ status: 409, code: 'whatsapp_disconnected' });
  });

  it('exposes no speed, protection or pacing setting', async () => {
    const { fetch } = fakeFetch();
    const client = await connect(baseConfig(), fetch);
    const tool = (await client.listTools()).tools.find((t) => t.name === 'check_numbers')!;
    const props = Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties).sort();
    expect(props).toEqual(['job_id', 'limit', 'numbers', 'offset', 'refresh', 'status']);
  });
});
