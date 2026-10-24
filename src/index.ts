#!/usr/bin/env node
// Entrypoint: stdio transport. stdout carries the protocol, so every
// diagnostic goes to stderr.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { startup } from './startup.js';

const server = startup(process.env, { log: (line) => process.stderr.write(`${line}\n`) });
if (server === null) {
  process.exit(1);
}
await server.connect(new StdioServerTransport());
