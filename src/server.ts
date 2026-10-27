// The MCP server: tools over the public customer API.
//
// Read-only by default. Every tool that puts a message on WhatsApp (SEND_TOOLS)
// is REGISTERED only when the operator opted in (GATEWAY_ALLOW_SEND is exactly
// "1" or "true"). When it is off, those tools do not exist: a client cannot
// list them or call them, and no code path in this file can reach a send
// endpoint.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { BRAND, SERVER_VERSION } from './brand.js';
import {
  chatSegmentProblem,
  GatewayClient,
  messageIdProblem,
  type ApiFailure,
  type ApiResult,
  type FetchLike,
} from './client.js';
import type { Config } from './config.js';

export const READ_TOOLS = [
  'channel_status',
  'list_chats',
  'read_messages',
  'list_groups',
  'get_group',
  'get_community',
  'list_community_subgroups',
  'get_contact',
] as const;
// D484: the number checker. Not a read (it creates a background check on the
// channel's own number) and not a send (no message leaves it), so it is neither
// in READ_TOOLS, whose members are all read-only hints, nor behind the send
// gate. Account and channel eligibility are enforced by the service.
export const CHECK_TOOLS = ['check_numbers'] as const;
export const CHECK_MAX_NUMBERS = 50;
const CHECK_ACCURACY = 'A check is a point-in-time answer and can be wrong or out of date; it is not a guarantee that a message will be delivered.';
export const SEND_TOOL = 'send_text';
// Every tool that puts a message on WhatsApp. All of them are behind the gate.
export const SEND_TOOLS = [SEND_TOOL, 'send_media', 'send_poll', 'react', 'unreact', 'delete_message'] as const;
export const MEDIA_KINDS = ['image', 'video', 'audio', 'voice', 'document'] as const;

// A failed send whose message MAY have been delivered. Retrying one of these is
// how the same WhatsApp message reaches a real person twice, so each is
// reported with delivery:'unknown' and told not to retry.
//   - no response arrived (network error, timeout, refused redirect);
//   - the API said so: ambiguous:true (core's 504 send_unconfirmed);
//   - a 504 or 502: a gateway timeout, or the edge's upstream_unreachable,
//     which it answers when the core did not answer IN TIME, not only when it
//     was never reached;
//   - a 2xx whose body could not be read: the send endpoint said OK.
// A 4xx is a refusal before anything was sent, and stays a plain error.
//
// One 502 is DEFINITE: media_upload_failed, core's answer that the upload to
// WhatsApp's media servers failed before any message existed. That one is safe
// to retry, and calling it unknown would stop an agent from a safe retry.
export function sendDeliveryUnknown(res: ApiFailure): boolean {
  if (res.status === null || res.ambiguous === true) return true;
  if (res.status === 502 && res.code === 'media_upload_failed') return false;
  return res.status === 502 || res.status === 504 || (res.status >= 200 && res.status < 300);
}

export interface ServerDeps {
  fetch?: FetchLike;
  timeoutMs?: number;
}

function ok(body: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
}

function fail(details: Record<string, unknown>): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(details, null, 2) }] };
}

function toResult(res: ApiResult): CallToolResult {
  if (res.ok) return ok(res.body);
  const { ok: _ok, ...details } = res;
  return fail(details);
}

// The answer to any send: a plain result, or, when delivery is unknown, an
// error that says so and carries NO retry guidance. A proxy or edge in front
// of core can put Retry-After (or retry_after) on a 504, and a model reads
// "retry_after" as "wait, then send again", which is the double-send. Only a
// 429 (nothing was sent) keeps it.
function sendResult(res: ApiResult, checkTool: string): CallToolResult {
  if (!res.ok && sendDeliveryUnknown(res)) {
    const { ok: _ok, retry_after: _retryAfter, window: _window, resets_at: _resetsAt, ...details } = res;
    return fail({
      ...details,
      delivery: 'unknown',
      note:
        `The message may have been sent. Do NOT send it again: check the chat first, with ${checkTool} for this chat` +
        (res.id !== undefined ? `, looking for id ${res.id}.` : '.'),
    });
  }
  return toResult(res);
}

const SEND_WARNING =
  'Nothing is retried automatically, and you must not retry either when delivery is unknown. ' +
  'If the result has delivery "unknown", the message MAY ALREADY HAVE BEEN SENT: do NOT send it again; ' +
  'check read_messages for that chat instead. On a 429 nothing was sent: wait retry_after seconds before any new attempt.';

export function createServer(config: Config, deps: ServerDeps = {}): McpServer {
  const client = new GatewayClient(config, deps.fetch, deps.timeoutMs);
  const server = new McpServer({ name: BRAND.packageName, version: SERVER_VERSION });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

  server.registerTool(
    'channel_status',
    {
      title: 'Channel status',
      description:
        `Read this channel's state from ${BRAND.productName}: whether the number is linked and connected. ` +
        'Set include_safety to also read the channel\'s health readings and overall verdict.',
      inputSchema: {
        include_safety: z
          .boolean()
          .optional()
          .describe('Also read the safety readings (a second GET request). Default false.'),
      },
      annotations: readOnly,
    },
    async ({ include_safety }) => {
      const status = await client.request('GET', client.sessionUrl());
      if (!status.ok || !include_safety) return toResult(status);
      const safety = await client.request('GET', client.sessionUrl('safety'));
      if (!safety.ok) return toResult(safety);
      return ok({ session: status.body, safety: safety.body });
    },
  );

  server.registerTool(
    'list_chats',
    {
      title: 'List chats',
      description:
        `List the chats ${BRAND.productName} has observed on this channel, from its own message log. ` +
        'This is not the account\'s full chat list: chats with no activity since the number was linked are absent. ' +
        'Returns up to 100 chats; the public API does not accept paging parameters.',
      inputSchema: {},
      annotations: readOnly,
    },
    async () => toResult(await client.request('GET', client.sessionUrl('chats'))),
  );

  server.registerTool(
    'read_messages',
    {
      title: 'Read a conversation',
      description:
        'Read one conversation from this channel\'s message log, newest first: a person or a group. ' +
        'For a person, both of their WhatsApp addresses (phone number and LID) are read as one timeline where the ' +
        'channel holds the lid_lookup grant; `merge` says whether that happened, and each message\'s `source_chat` ' +
        'says which address it came from. In a group, each sender is one identity (`sender_jid`, with `sender_lid` ' +
        'beside it). Pages hold up to `limit` messages (default 50); when `next_before` is present, pass it as ' +
        '`before` to read the next, older page. Only messages captured while the channel was connected are present, ' +
        'plus history the phone sent if the channel stores it (`source: history_sync`). Every page read is recorded ' +
        'in the channel\'s API access records.',
      inputSchema: {
        chat: z
          .string()
          .min(1)
          .describe(
            'The chat: a JID such as 15551234567@s.whatsapp.net or 120363000000000000@g.us, ' +
              'or a phone number in international form. Use chat_jid values from list_chats.',
          ),
        limit: z.number().int().min(1).max(500).optional().describe('Messages per page, 1 to 500. Default 50.'),
        before: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,256}$/)
          .optional()
          .describe('The next_before value of a previous page, exactly as returned.'),
      },
      annotations: readOnly,
    },
    async ({ chat, limit, before }) => {
      const problem = chatSegmentProblem(chat);
      if (problem !== null) return fail({ status: null, code: null, error: problem });
      const query = new URLSearchParams();
      if (limit !== undefined) query.set('limit', String(limit));
      if (before !== undefined) query.set('before', before);
      const qs = query.toString();
      const url = client.sessionUrl('chats', chat, 'messages') + (qs === '' ? '' : `?${qs}`);
      return toResult(await client.request('GET', url));
    },
  );

  // READS THAT ASK WHATSAPP. Groups and communities are read from WhatsApp
  // itself, not from the gateway's log, and WhatsApp throttles a number that
  // asks too often (429 whatsapp_rate_limited). The descriptions say so, so an
  // agent does not poll them.
  const askWhatsApp =
    'This asks WhatsApp itself; do not poll it. A 429 whatsapp_rate_limited means WhatsApp is throttling the ' +
    'number: wait retry_after seconds.';
  const jidArg = (what: string, example: string) =>
    z.string().min(1).describe(`The ${what} JID, for example ${example}.`);
  const segmentRead = (segments: string[]) => async (): Promise<CallToolResult> => {
    for (const seg of segments) {
      const problem = chatSegmentProblem(seg);
      if (problem !== null) return fail({ status: null, code: null, error: problem });
    }
    return toResult(await client.request('GET', client.sessionUrl(...segments)));
  };

  server.registerTool(
    'list_groups',
    {
      title: 'List groups',
      description: 'List the WhatsApp groups this channel\'s number is in. ' + askWhatsApp,
      inputSchema: {},
      annotations: readOnly,
    },
    segmentRead(['groups']),
  );

  server.registerTool(
    'get_group',
    {
      title: 'Get a group',
      description: 'Read one group: its subject, description, settings and participants. ' + askWhatsApp,
      inputSchema: { group: jidArg('group', '120363000000000001@g.us') },
      annotations: readOnly,
    },
    async ({ group }) => segmentRead(['groups', group])(),
  );

  server.registerTool(
    'get_community',
    {
      title: 'Get a community',
      description: 'Read one community this channel\'s number belongs to. ' + askWhatsApp,
      inputSchema: { community: jidArg('community', '120363000000000002@g.us') },
      annotations: readOnly,
    },
    async ({ community }) => segmentRead(['communities', community])(),
  );

  server.registerTool(
    'list_community_subgroups',
    {
      title: 'List a community\'s subgroups',
      description: 'List the groups linked to a community. ' + askWhatsApp,
      inputSchema: { community: jidArg('community', '120363000000000002@g.us') },
      annotations: readOnly,
    },
    async ({ community }) => segmentRead(['communities', community, 'subgroups'])(),
  );

  server.registerTool(
    'get_contact',
    {
      title: 'Get a contact',
      description:
        'Read this channel\'s stored entry for one contact (the names its contact store holds); this does not ask WhatsApp. ' +
        '`who` is a phone JID such as 15551234567@s.whatsapp.net, or a LID.',
      inputSchema: { who: z.string().min(1).describe('The contact: a user JID or a LID.') },
      annotations: readOnly,
    },
    async ({ who }) => segmentRead(['contacts', who])(),
  );

  // THE NUMBER CHECKER (D484). One tool, two uses: start a check from a short
  // list, or read one by its id. The check runs in the background.
  server.registerTool(
    'check_numbers',
    {
      title: 'Check to ensure numbers are still on WhatsApp',
      description:
        `Check to ensure phone numbers are still on WhatsApp, using this channel's own number. Use this to keep your own contacts current: check that numbers you already have are still on WhatsApp. It is not for lists of people you have never talked to. Two uses. ` +
        `(1) Pass \`numbers\` (1 to ${CHECK_MAX_NUMBERS} per call) to start a check: it returns a job at once and keeps running ` +
        'in the background. (2) Pass `job_id` to read that job: its state, progress, allowance, estimate, pause reason, ' +
        'and a page of result rows. Each row has status (registered, not_registered, invalid, error), phone_e164, ' +
        'country, jid, lid, is_business and verified_name (is_business appears only when true; omitted means not ' +
        'known to be a verified business, never "personal"), checked_at, and cached with age_seconds. ' +
        'Checks run in the background and are spaced out, and each number has a daily check allowance, so a large list can take hours or days. ' +
        'A paused job says why in pause and resumes by itself at pause.resume_at, so do not poll it in a loop and do not start the same list again; only channel_down waits for you. ' +
        'A failed job reports its code and reason in failure (check_failed for an upstream failure). ' +
        'Numbers checked recently are answered from a cache (7 days if on WhatsApp, 24 hours if not) without asking WhatsApp or using the allowance; ' +
        'set refresh to ask WhatsApp again. There is no way to make a check faster. The channel must be connected and non-sandbox. ' +
        'ACCURACY: a check is a point-in-time answer and can be wrong or out of date by the time you use it; ' +
        'it is not a guarantee that a message will be delivered. ' +
        'The number checker is included with every paid number. The account needs at least one active non-sandbox channel, ' +
        'including paid, complimentary, promotional or admin grants. Without one, the service returns 403 number_checker_requires_paid_number. ' +
        'A sandbox request from an eligible account returns 403 number_checker_requires_non_sandbox_channel.',
      inputSchema: {
        numbers: z
          .array(z.string().min(1).max(64))
          .min(1)
          .max(CHECK_MAX_NUMBERS)
          .optional()
          .describe(
            `Phone numbers to check, 1 to ${CHECK_MAX_NUMBERS}, as you have them: a leading +, spaces and dashes are fine. Start with the country code. Omit when reading a job.`,
          ),
        job_id: z
          .string()
          .regex(/^nck_[0-9a-f]{24}$/)
          .optional()
          .describe('The id of a job started earlier (nck_ then 24 hex characters). Pass this instead of numbers to read it.'),
        refresh: z.boolean().optional().describe('With numbers: ask WhatsApp again even for numbers answered recently. Default false.'),
        offset: z.number().int().min(0).max(999999).optional().describe('With job_id: result rows to skip. Default 0.'),
        limit: z.number().int().min(1).max(2000).optional().describe('With job_id: result rows to return, 1 to 2000. Default 500.'),
        status: z
          .array(z.enum(['pending', 'registered', 'not_registered', 'invalid', 'error']))
          .min(1)
          .optional()
          .describe('With job_id: only rows with these statuses.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ numbers, job_id, refresh, offset, limit, status }) => {
      if ((numbers === undefined) === (job_id === undefined)) {
        return fail({ status: null, code: null, error: 'pass exactly one of numbers (start a check) or job_id (read one)' });
      }
      if (numbers !== undefined) {
        const body: { numbers: string[]; refresh?: boolean } = { numbers };
        if (refresh !== undefined) body.refresh = refresh;
        const created = await client.request('POST', client.sessionUrl('number-checks'), body);
        if (!created.ok) return toResult(created);
        return ok({ ...(created.body as Record<string, unknown>), accuracy: CHECK_ACCURACY });
      }
      const job = await client.request('GET', client.sessionUrl('number-checks', job_id!));
      if (!job.ok) return toResult(job);
      const query = new URLSearchParams();
      if (offset !== undefined) query.set('offset', String(offset));
      if (limit !== undefined) query.set('limit', String(limit));
      if (status !== undefined) query.set('status', [...new Set(status)].join(','));
      const qs = query.toString();
      const rows = await client.request('GET', client.sessionUrl('number-checks', job_id!, 'results') + (qs === '' ? '' : `?${qs}`));
      if (!rows.ok) return toResult(rows);
      const page = rows.body as { results?: unknown; total?: unknown };
      return ok({ job: job.body, results: page.results ?? [], total: page.total ?? 0, accuracy: CHECK_ACCURACY });
    },
  );

  // THE SEND GATE. The only place a send tool is registered.
  if (config.allowSend) {
    server.registerTool(
      SEND_TOOL,
      {
        title: 'Send a text message',
        description:
          'Send a WhatsApp text message from this channel. This sends a real message from a real number ' +
          'to a real person, and counts against the daily message allowance (sandbox channels). ' +
          'Nothing is retried automatically, and you must not retry either when delivery is unknown. ' +
          'If the result has delivery "unknown", the message MAY ALREADY HAVE BEEN SENT: do NOT send it again. ' +
          'That happens when no response arrived, when the result has ambiguous true, and on a 502 or 504 ' +
          'response: a 502 or 504 is a response, and it can still mean the message was sent. ' +
          'Instead, check read_messages for that chat, and look for the returned id when there is one. ' +
          'On a 429, the message was not sent: wait retry_after seconds before any new attempt.',
        inputSchema: {
          to: z
            .string()
            .min(1)
            .describe('A phone number in full international form, country code included, or a WhatsApp JID.'),
          text: z.string().min(1).describe('The message text.'),
          quoted: z
            .string()
            .min(1)
            .optional()
            .describe('Optional. The ID of a message this channel has in the same chat, to reply to it.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ to, text, quoted }) => {
        const body: { to: string; text: string; quoted?: string } = { to, text };
        if (quoted !== undefined) body.quoted = quoted;
        return sendResult(await client.request('POST', client.sessionUrl('messages', 'text'), body), 'read_messages');
      },
    );

    const sendAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
    const to = z
      .string()
      .min(1)
      .describe('A phone number in full international form, country code included, or a WhatsApp JID.');

    server.registerTool(
      'send_media',
      {
        title: 'Send an image, video, audio file, voice note or document',
        description:
          'Send media from this channel. The gateway FETCHES the file from `url` (http or https, a public address, ' +
          'at most 3 redirects) and sends it as a real message to a real person; it counts as one message against ' +
          'the daily message allowance (sandbox channels), whatever its size. Limits: image JPEG/PNG 5 MiB; video MP4/3GPP 16 MiB; audio ' +
          'AAC/MP4/MP3/AMR/Ogg 16 MiB; voice Ogg Opus 16 MiB; document any type 32 MiB. The type is read from the ' +
          'file, not the URL. A 502 with code media_upload_failed means nothing was sent and a retry is safe; a 429 ' +
          'gateway_busy (bound "media") means wait retry_after seconds. ' +
          SEND_WARNING,
        inputSchema: {
          kind: z.enum(MEDIA_KINDS).describe('What to send it as.'),
          to,
          url: z.string().url().describe('Where the gateway fetches the file.'),
          caption: z.string().min(1).optional().describe('Optional, for image, video and document only.'),
          filename: z.string().min(1).optional().describe('Optional, for document only: the name the recipient sees.'),
          mime_type: z.string().min(1).optional().describe('Optional, for document only.'),
        },
        annotations: sendAnnotations,
      },
      async ({ kind, to, url, caption, filename, mime_type }) => {
        const body: Record<string, string> = { to, url };
        if (caption !== undefined) body.caption = caption;
        if (filename !== undefined) body.filename = filename;
        if (mime_type !== undefined) body.mime_type = mime_type;
        return sendResult(await client.request('POST', client.sessionUrl('messages', kind), body), 'read_messages');
      },
    );

    server.registerTool(
      'send_poll',
      {
        title: 'Send a poll',
        description:
          'Send a poll from this channel: a question and 2 to 12 different options, one answer unless multiple is ' +
          'true. Votes come back to the channel\'s webhook as poll_vote messages, by option name, and appear in ' +
          'read_messages. Counts as one message against the daily message allowance (sandbox channels). ' +
          SEND_WARNING,
        inputSchema: {
          to,
          question: z.string().min(1).max(255).describe('The question.'),
          options: z.array(z.string().min(1).max(100)).min(2).max(12).describe('The options, each different.'),
          multiple: z.boolean().optional().describe('Let a voter choose more than one option. Default false.'),
        },
        annotations: sendAnnotations,
      },
      async ({ to, question, options, multiple }) => {
        const body: Record<string, unknown> = { to, question, options };
        if (multiple !== undefined) body.multiple = multiple;
        return sendResult(await client.request('POST', client.sessionUrl('messages', 'poll'), body), 'read_messages');
      },
    );

    const messageId = z
      .string()
      .min(1)
      .describe('The id of a message this channel sent or received (the id field from read_messages).');

    server.registerTool(
      'react',
      {
        title: 'React to a message',
        description:
          'React with one emoji to a message this channel sent or received; a new reaction replaces this ' +
          'channel\'s earlier one. A message the channel has no record of answers 404 message_not_found. ' +
          'A reaction is a message on WhatsApp and counts as one against the daily message allowance (sandbox channels). ' +
          SEND_WARNING,
        inputSchema: { message_id: messageId, emoji: z.string().min(1).describe('One emoji.') },
        annotations: sendAnnotations,
      },
      async ({ message_id, emoji }) => {
        const problem = messageIdProblem(message_id);
        if (problem !== null) return fail({ status: null, code: null, error: problem });
        return sendResult(
          await client.request('PUT', client.sessionUrl('messages', message_id, 'reaction'), { emoji }),
          'read_messages',
        );
      },
    );

    server.registerTool(
      'unreact',
      {
        title: 'Remove a reaction',
        description:
          'Remove this channel\'s reaction to a message. WhatsApp sends the removal as a message, so it counts ' +
          'as one against the daily message allowance (sandbox channels). ' +
          SEND_WARNING,
        inputSchema: { message_id: messageId },
        annotations: sendAnnotations,
      },
      async ({ message_id }) => {
        const problem = messageIdProblem(message_id);
        if (problem !== null) return fail({ status: null, code: null, error: problem });
        return sendResult(await client.request('DELETE', client.sessionUrl('messages', message_id, 'reaction')), 'read_messages');
      },
    );

    server.registerTool(
      'delete_message',
      {
        title: 'Delete a message for everyone',
        description:
          'Delete for everyone a message this channel\'s number sent, within 48 hours of sending. Someone else\'s ' +
          'message answers 403 not_own_message; an older one 409 revoke_window_passed; one the channel has no record ' +
          'of 404 message_not_found. Deleting a message already deleted answers status already_revoked and sends ' +
          'nothing. The delete is a message on WhatsApp and counts as one against the daily message allowance (sandbox channels). ' +
          SEND_WARNING,
        inputSchema: { message_id: messageId },
        annotations: sendAnnotations,
      },
      async ({ message_id }) => {
        const problem = messageIdProblem(message_id);
        if (problem !== null) return fail({ status: null, code: null, error: problem });
        return sendResult(await client.request('DELETE', client.sessionUrl('messages', message_id)), 'read_messages');
      },
    );
  }

  return server;
}
