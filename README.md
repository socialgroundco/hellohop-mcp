# hellohop-mcp

[![M8ven Verified](https://m8ven.ai/badge/mcp/socialgroundco-hellohop-mcp-1ismdw?variant=verified)](https://m8ven.ai/mcp/socialgroundco-hellohop-mcp-1ismdw?s=readme)

HelloHop is an independent WhatsApp API for developers: send and receive messages, automate groups and communities, and get signed webhooks, from $25 USD per number per month with a free sandbox.

This is the HelloHop MCP server. It lets an MCP client (for example Claude Desktop, Claude Code or Cursor) work with one channel of the public API: read the channel's status, the chats it has observed, recent messages, its groups and communities, and a contact. Sending (a text, media by URL, a poll, a reaction) is **off by default** and available only when you turn it on. Docs: https://hellohop.app/docs/mcp. HelloHop is not affiliated with or endorsed by WhatsApp or Meta.

## Install

Requires Node.js 22 or later. Run it with `npx`, no separate install step:

```sh
npx -y hellohop-mcp
```

Your MCP client starts the server for you once it is configured (see Claude Desktop and Claude Code below). The server reads its settings from the environment variables listed under Environment.

## Tools

| Tool | Request | Notes |
|---|---|---|
| `channel_status` | `GET {base}/sessions/{channel}` | `include_safety: true` also reads `GET {base}/sessions/{channel}/safety`. |
| `list_chats` | `GET {base}/sessions/{channel}/chats` | Up to 100 chats from the channel's own log. |
| `read_messages` | `GET {base}/sessions/{channel}/chats/{chat}/messages` | Up to `limit` messages (default 50, at most 500); `next_before` goes back as `before`. `chat` is sent as written, for example `15551234567@s.whatsapp.net`. |
| `list_groups` | `GET {base}/sessions/{channel}/groups` | Asks WhatsApp; do not poll (a throttled number answers 429 `whatsapp_rate_limited`). |
| `get_group` | `GET {base}/sessions/{channel}/groups/{group}` | Asks WhatsApp. |
| `get_community` | `GET {base}/sessions/{channel}/communities/{community}` | Asks WhatsApp. |
| `list_community_subgroups` | `GET {base}/sessions/{channel}/communities/{community}/subgroups` | Asks WhatsApp. |
| `get_contact` | `GET {base}/sessions/{channel}/contacts/{who}` | The channel's stored contact entry; does not ask WhatsApp. |
| `send_text` | `POST {base}/sessions/{channel}/messages/text` | Only when `GATEWAY_ALLOW_SEND=1`. Body `{to, text}`, plus `quoted` if given. |
| `send_media` | `POST {base}/sessions/{channel}/messages/{kind}` | Only when `GATEWAY_ALLOW_SEND=1`. `kind` is `image`, `video`, `audio`, `voice` or `document`; body `{to, url}` plus `caption`, `filename`, `mime_type` if given. The gateway fetches the URL. |
| `send_poll` | `POST {base}/sessions/{channel}/messages/poll` | Only when `GATEWAY_ALLOW_SEND=1`. Body `{to, question, options}` (2 to 12), plus `multiple` if given. |
| `react` | `PUT {base}/sessions/{channel}/messages/{message_id}/reaction` | Only when `GATEWAY_ALLOW_SEND=1`. Body `{emoji}`. |
| `unreact` | `DELETE {base}/sessions/{channel}/messages/{message_id}/reaction` | Only when `GATEWAY_ALLOW_SEND=1`. No body. |
| `delete_message` | `DELETE {base}/sessions/{channel}/messages/{message_id}` | Only when `GATEWAY_ALLOW_SEND=1`. No body. Deletes for everyone a message this number sent, within 48 hours. |

`check_numbers` (always registered; it sends no message) starts a number check from 1 to 50 `numbers` (`POST {base}/sessions/{channel}/number-checks`, plus `refresh` if given), or reads one by `job_id` (`GET` the check, then a page of its rows with `offset`, `limit` and `status`). The check runs in the background on the channel's own connected non-sandbox number, spaced out, with a daily check allowance by number age, so a long list takes hours or days and it cannot be made faster. The number checker is included with every paid number. The account needs at least one active non-sandbox channel, including one covered by a paid, complimentary, promotional or admin grant. Otherwise the service returns 403 `number_checker_requires_paid_number`; a sandbox request from an eligible account returns 403 `number_checker_requires_non_sandbox_channel`. A paused check says why and resumes by itself (only `channel_down` waits for you; `account_suspended` must be resolved); a failed check reports its code and reason in `failure` (`check_failed` for an upstream failure). Read its reason before retrying. Rows carry `phone_e164`, `country`, `jid`, `lid`, `is_business` (present only when true), `verified_name`, `checked_at`, and `cached` with `age_seconds`. A check is a point-in-time answer and can be wrong or out of date; it does not promise delivery.

Not exposed, on purpose: group and community invite links (an agent could paste an open invite into a chat), media download (bytes, not JSON) and webhook configuration.

`get_group` returns the group's participant list, which is your own group data, so it enters the MCP client's context like any other tool result. Use it only with a client you trust with those member identities.

The public API forwards only `limit` (1 to 500) and `before` on the conversation read, so `read_messages` pages with those two and no other query string reaches the API. The other list tools take no paging parameters.

A chat is sent in the URL path without percent-encoding, because the API refuses any path containing `%`. A chat containing anything other than letters, digits and `@ . : _ + -` is refused before a request is made.

Every request sends `Authorization: Bearer <token>`. A successful response is returned as JSON text. An HTTP error is returned as a tool error with `status`, `code` and `error`, plus `retry_after` (and `window`, `resets_at`, `ambiguous`, `id`) when the API sends them. The token is redacted from every string returned, success bodies included. Nothing is retried automatically, and a redirect is refused rather than followed.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `GATEWAY_API_URL` | no | Your API base. Defaults to `https://api.hellohop.app/v1`, the public API. Must be https (http is accepted only for localhost). |
| `GATEWAY_API_TOKEN` | yes | A channel key, or an account key for any number in the account. It is never logged. |
| `GATEWAY_CHANNEL_ID` | yes | The one number this server operates on, including when using an account key. |
| `GATEWAY_ALLOW_SEND` | no | Set to exactly `1` or `true` to enable the send tools (`send_text`, `send_media`, `send_poll`, `react`, `unreact`, `delete_message`). Any other value, or unset, leaves them off. |

An account key starts with `hh_acct_` and works in `GATEWAY_API_TOKEN` without any other change. `GATEWAY_CHANNEL_ID` still selects one owned number per server. Create the key in Account in the console; it is shown once. Rotate with Regenerate, then update this configuration. The key cannot manage billing, number slots, credentials, teams, grants or company terms.

If a required variable is missing the server writes the reason to stderr and exits with status 1.

## Sending is off by default

Without `GATEWAY_ALLOW_SEND=1` no send tool is registered: a client cannot see or call them, and the server never contacts a send endpoint. With it on, every call sends a real WhatsApp message from the linked number (a reaction, its removal and a delete included) and counts as one against the daily message allowance (sandbox channels).

### A send can succeed without saying so

A failed `send_text` carries `delivery: "unknown"` when the message may have been sent anyway: no response arrived, the API answered `ambiguous: true` (a 504 `send_unconfirmed`, with the `id` of the row it logged), or the answer was any other 502 or 504. Do not send it again. Check `read_messages` for that chat first. Sending it again is how the same message reaches a real person twice.

### Prompt injection: read and send together let strangers steer sends

`read_messages` puts text written by third parties, anyone who can message the number, into the model's context. With `GATEWAY_ALLOW_SEND=1` in the same server, that text can instruct the model to send messages, to anyone, with any content. This is not solved by trusting the client or the person using it: the instructions come from the messages being read.

Run reading and sending as two separate client configurations:

- a read-only entry, without `GATEWAY_ALLOW_SEND`, for anything that reads messages;
- a send entry, with `GATEWAY_ALLOW_SEND=1`, enabled only in a session that needs to send, with every `send_text` call approved by a person who reads its `to` and `text`.

The send entry still registers the read tools, so a session using it is exposed the moment it reads messages. Keep that session away from `read_messages` unless you trust everyone who can message the number.

## Claude Desktop

Add an entry to `mcpServers` in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "hellohop-mcp": {
      "command": "npx",
      "args": ["-y", "hellohop-mcp"],
      "env": {
        "GATEWAY_API_TOKEN": "<CHANNEL_TOKEN>",
        "GATEWAY_CHANNEL_ID": "<CHANNEL_ID>"
      }
    }
  }
}
```

Add `"GATEWAY_ALLOW_SEND": "1"` to `env` to enable sending. Restart Claude Desktop after editing the file.

## Claude Code

```sh
claude mcp add hellohop-mcp \
  -e GATEWAY_API_TOKEN=<CHANNEL_TOKEN> \
  -e GATEWAY_CHANNEL_ID=<CHANNEL_ID> \
  -- npx -y hellohop-mcp
```

Add `-e GATEWAY_ALLOW_SEND=1` before `--` to enable sending.

Both clients store the token in their configuration file in plain text. Use the channel's own token, never an operator credential.

## Cursor

Add the same entry to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "hellohop-mcp": {
      "command": "npx",
      "args": ["-y", "hellohop-mcp"],
      "env": {
        "GATEWAY_API_TOKEN": "<CHANNEL_TOKEN>",
        "GATEWAY_CHANNEL_ID": "<CHANNEL_ID>"
      }
    }
  }
}
```

Sending stays off unless you add `"GATEWAY_ALLOW_SEND": "1"` to `env`.

## Example requests

Once connected, ask your assistant in plain language. For example:

- "What is the status of my channel?" (calls `channel_status`)
- "Show the last 20 messages in my chat with 15551234567@s.whatsapp.net." (calls `read_messages`)
- "List the groups this number is in." (calls `list_groups`)

## License

MIT. Full documentation: https://hellohop.app/docs/mcp
