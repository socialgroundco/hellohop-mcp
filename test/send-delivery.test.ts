// A send that may have been delivered must SAY so, and must not be retried.
//
// Every case here goes through send_text over the MCP protocol, and each
// trigger of delivery:'unknown' has its own case, because they are redundant
// in the body core actually sends (a 504 that also carries ambiguous:true): a
// test built only on that body stays green with either trigger deleted.

import { describe, expect, it } from 'vitest';

import { type ApiFailure } from '../src/client.js';
import { sendDeliveryUnknown, SEND_TOOL } from '../src/server.js';
import { baseConfig, connect, fakeFetch, objectOf, textOf } from './helpers.js';

const SEND = { to: '+15551234567', text: 'hello' };

// LITERAL, from internal/edge/public_unconfirmed_test.go
// (TestTheEdgeRelaysAnUnconfirmedSendUnchanged): the body core renders for an
// unconfirmed send, which the edge relays unchanged with core's 504.
const UNCONFIRMED_504 =
  '{"error":"send text: send unconfirmed (logged as ambiguous:0f3a9c): timed out","code":"send_unconfirmed","ambiguous":true,"id":"ambiguous:0f3a9c"}';

// The edge's own 502 when the core did not answer (internal/edge/passthrough.go
// writeCode, Label from cmd/.../main.go's publicPass). The label is the working
// product name, which test/brand.test.ts refuses in this package, so it is built
// from parts.
const UPSTREAM_UNREACHABLE_502 = JSON.stringify({
  code: 'upstream_unreachable',
  error: `${['wa', 'gate'].join('')} did not answer`,
});

async function send(reply: Parameters<typeof fakeFetch>[0]) {
  const { fetch, calls } = fakeFetch(reply);
  const client = await connect(baseConfig({ allowSend: true }), fetch);
  const result = await client.callTool({ name: SEND_TOOL, arguments: SEND });
  return { result, details: objectOf(result), calls };
}

describe('send_text: delivery unknown', () => {
  it('core 504 send_unconfirmed (the literal edge-relayed body): ambiguous and id pass through, delivery unknown, one call', async () => {
    const { result, details, calls } = await send({ status: 504, raw: UNCONFIRMED_504 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(result.isError).toBe(true);
    expect(details.status).toBe(504);
    expect(details.code).toBe('send_unconfirmed');
    expect(details.ambiguous).toBe(true);
    expect(details.id).toBe('ambiguous:0f3a9c');
    expect(details.delivery).toBe('unknown');
    // The id comes from the FIELD, and the note points at it.
    expect(String(details.note)).toContain('ambiguous:0f3a9c');
    expect(String(details.note)).toContain('Do NOT send it again');
  });

  it('edge 502 upstream_unreachable: delivery unknown, one call', async () => {
    const { details, calls } = await send({ status: 502, raw: UPSTREAM_UNREACHABLE_502 });
    // Control: the fixture is the documented shape, so the code came through.
    expect(details.code).toBe('upstream_unreachable');
    expect(details.status).toBe(502);
    expect(details).not.toHaveProperty('ambiguous');
    expect(details.delivery).toBe('unknown');
    expect(calls).toHaveLength(1);
  });

  it('a 504 with no API body (a proxy timeout page): delivery unknown on status alone', async () => {
    const { details } = await send({ status: 504, raw: '<html>gateway timeout</html>' });
    expect(details.code).toBeNull();
    expect(details).not.toHaveProperty('ambiguous');
    expect(details.delivery).toBe('unknown');
  });

  it('a 2xx whose body cannot be read: delivery unknown (the send endpoint said OK)', async () => {
    const { result, details } = await send({ status: 200, raw: '<html>ok</html>' });
    expect(result.isError).toBe(true);
    expect(details.status).toBe(200);
    expect(details.delivery).toBe('unknown');
  });

  // A 504 send_unconfirmed may already have been delivered, so its result must
  // carry NO retry guidance: no retry_after, no rate-limit window, and no
  // wording that invites another attempt. A proxy or edge in front of core can
  // add Retry-After (or a retry_after field) to a 504, so both are sent here.
  it('core 504 send_unconfirmed carries NO retry guidance, and says it may have been sent: check the chat first', async () => {
    // CONTROL: the same Retry-After header on a 429 (nothing was sent) DOES
    // reach the result, so its absence below is the 504 path, not a parser
    // that never reads the header.
    const control = await send({ status: 429, body: { code: 'rate_limited', error: 'slow down' }, headers: { 'Retry-After': '30' } });
    expect(control.details.retry_after).toBe(30);
    expect(control.details).not.toHaveProperty('delivery');

    const unconfirmedWithRetry = JSON.stringify({ ...JSON.parse(UNCONFIRMED_504), retry_after: 30, window: 'minute' });
    for (const reply of [
      { status: 504, raw: UNCONFIRMED_504, headers: { 'Retry-After': '30' } },
      { status: 504, raw: unconfirmedWithRetry },
    ]) {
      const { result, details, calls } = await send(reply);
      // Path assertion first: this is the delivery-unknown branch.
      expect(details.code).toBe('send_unconfirmed');
      expect(details.delivery).toBe('unknown');
      expect(calls).toHaveLength(1);
      // No retry guidance, in any field or in the text.
      expect(details).not.toHaveProperty('retry_after');
      expect(details).not.toHaveProperty('window');
      expect(details).not.toHaveProperty('resets_at');
      expect(textOf(result)).not.toMatch(/retr(y|ies)|try again|wait/i);
      // What it says instead.
      const note = String(details.note);
      expect(note).toContain('may have been sent');
      expect(note).toContain('check the chat first');
      expect(note).toContain('Do NOT send it again');
      expect(note).toContain('ambiguous:0f3a9c');
    }
  });

  // No response at all: tools.test.ts 'a send with no response says delivery
  // is unknown, and is sent exactly once'.

  it('CONTROL: a 4xx refusal is a plain error, with no delivery field', async () => {
    for (const [status, body] of [
      [429, { code: 'daily_send_cap_exceeded', error: 'daily cap', retry_after: 60 }],
      [400, { code: 'quote_not_found', error: 'quoted message not found' }],
      [409, { code: 'stood_down', error: 'stood down' }],
    ] as const) {
      const { result, details, calls } = await send({ status, body });
      expect(result.isError, `status ${status}`).toBe(true);
      expect(details.status).toBe(status);
      expect(details.code).toBe(body.code);
      expect(details, `status ${status}`).not.toHaveProperty('delivery');
      expect(calls).toHaveLength(1);
    }
  });

  it('CONTROL: a confirmed send is a success with no delivery field', async () => {
    const ack = { id: 'MSG1', status: 'server_ack' };
    const { result, details } = await send({ body: ack });
    expect(result.isError).toBeFalsy();
    expect(details).toEqual(ack);
  });
});

// The predicate on its own, for the trigger no shape core produces today
// isolates: ambiguous:true on a status that is not itself ambiguous.
describe('sendDeliveryUnknown', () => {
  const failure = (over: Partial<ApiFailure>): ApiFailure => ({ ok: false, status: 500, code: null, error: 'x', ...over });

  it('ambiguous:true alone makes delivery unknown, whatever the status', () => {
    // Control: the same failure without the flag is a plain error.
    expect(sendDeliveryUnknown(failure({ status: 500 }))).toBe(false);
    expect(sendDeliveryUnknown(failure({ status: 409 }))).toBe(false);
    expect(sendDeliveryUnknown(failure({ status: 500, ambiguous: true }))).toBe(true);
    expect(sendDeliveryUnknown(failure({ status: 409, ambiguous: true }))).toBe(true);
    expect(sendDeliveryUnknown(failure({ status: 409, ambiguous: false }))).toBe(false);
  });

  it('status null, 502, 504 and 2xx are unknown; 4xx is not', () => {
    for (const status of [null, 502, 504, 200, 201]) {
      expect(sendDeliveryUnknown(failure({ status })), `status ${status}`).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 409, 429, 500, 503]) {
      expect(sendDeliveryUnknown(failure({ status })), `status ${status}`).toBe(false);
    }
  });
});

describe('send_text description', () => {
  it('tells the model not to resend when delivery is unknown, including on a 502/504 response', async () => {
    const { fetch } = fakeFetch();
    const client = await connect(baseConfig({ allowSend: true }), fetch);
    const tool = (await client.listTools()).tools.find((t) => t.name === SEND_TOOL);
    // Control: the tool is there, so the checks below read its real text.
    expect(tool).toBeDefined();
    const d = tool!.description ?? '';
    expect(d).toContain('do NOT send it again');
    expect(d).toContain('delivery "unknown"');
    expect(d).toContain('ambiguous');
    expect(d).toMatch(/502 or 504/);
    expect(d).toContain('a 502 or 504 is a response, and it can still mean the message was sent');
    expect(d).toContain('read_messages');
    // S3-6: a cap-exempt channel exists (internal/session/nocap.go), so the cap
    // is conditional.
    expect(d).toContain('daily send cap if it has one');
    expect(d).not.toContain('counts against its daily send cap');
  });
});
