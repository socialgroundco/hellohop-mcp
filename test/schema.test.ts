// Public tools/list contract, measured from the published 0.3.4 tarball.
// Catch lost v3 converter metadata, changed field optionality, and poll bounds
// when upgrading Zod. Exercise the SDK registration/conversion, not Zod alone.
import { expect, it } from 'vitest';

import { baseConfig, connect, fakeFetch } from './helpers.js';

const fields = {
  channel_status: [[], ['include_safety']],
  list_chats: [[], []],
  read_messages: [['chat'], ['limit', 'before']],
  list_groups: [[], []],
  get_group: [['group'], []],
  get_community: [['community'], []],
  list_community_subgroups: [['community'], []],
  get_contact: [['who'], []],
  check_numbers: [[], ['numbers', 'job_id', 'refresh', 'offset', 'limit', 'status']],
  send_text: [['to', 'text'], ['quoted']],
  send_media: [['kind', 'to', 'url'], ['caption', 'filename', 'mime_type']],
  send_poll: [['to', 'question', 'options'], ['multiple']],
  react: [['message_id', 'emoji'], []],
  unreact: [['message_id'], []],
  delete_message: [['message_id'], []],
} as const;

it('preserves required and optional fields for every published tool', async () => {
  const client = await connect(baseConfig({ allowSend: true }), fakeFetch().fetch);
  try {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(15);
    expect(tools.map(t => t.name).sort()).toEqual(Object.keys(fields).sort());
    for (const tool of tools) {
      const [required, optional] = fields[tool.name as keyof typeof fields];
      expect(tool.inputSchema.required ?? [], tool.name).toEqual(required);
      expect(Object.keys(tool.inputSchema.properties ?? {}).sort(), tool.name)
        .toEqual([...required, ...optional].sort());
    }
  } finally { await client.close(); }
});

it('preserves the published additionalProperties metadata without rejecting unknown fields', async () => {
  const client = await connect(baseConfig({ allowSend: true }), fakeFetch().fetch);
  try {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(15);
    for (const tool of tools) {
      const empty = tool.name === 'list_chats' || tool.name === 'list_groups';
      expect(tool.inputSchema.additionalProperties, tool.name).toBe(empty ? undefined : false);
    }
    // Positive control: an unknown field is still accepted, as in v3.
    const result = await client.callTool({ name: 'channel_status', arguments: { extra: true } });
    expect(result.isError).toBeFalsy();
  } finally { await client.close(); }
});

it('advertises a maximum of 12 poll options', async () => {
  const client = await connect(baseConfig({ allowSend: true }), fakeFetch().fetch);
  try {
    const { tools } = await client.listTools();
    const poll = tools.find(t => t.name === 'send_poll');
    expect(poll).toBeDefined();
    expect(poll!.inputSchema.properties?.options).toMatchObject({ minItems: 2, maxItems: 12 });
  } finally { await client.close(); }
});

it('passes accepted media URLs through without normalizing them', async () => {
  const { fetch, calls } = fakeFetch({ body: { id: 'media1' } });
  const client = await connect(baseConfig({ allowSend: true }), fetch);
  try {
    for (const url of ['https://example.test/file', ' https://example.test/file ', 'https://exa\nmple.test/file']) {
      const result = await client.callTool({ name: 'send_media', arguments: { kind: 'image', to: '1', url } });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(calls.at(-1)!.body!).url).toBe(url);
    }
    expect(calls).toHaveLength(3);
    const invalid = await client.callTool({ name: 'send_media', arguments: { kind: 'image', to: '1', url: 'not a url' } });
    expect(invalid.isError).toBe(true);
    expect(calls).toHaveLength(3);
  } finally { await client.close(); }
});
