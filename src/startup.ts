// Startup, separated from the entrypoint so it can be tested without a
// process: read the environment, fail clearly if it is incomplete, and build
// the server. Nothing written here ever contains the token.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { BRAND, SERVER_VERSION } from './brand.js';
import { ConfigError, ENV, loadConfig } from './config.js';
import type { FetchLike } from './client.js';
import { createServer } from './server.js';

export interface StartupDeps {
  // Where diagnostics go. stdout belongs to the MCP protocol, so the
  // entrypoint passes stderr.
  log: (line: string) => void;
  fetch?: FetchLike;
}

// Returns the server, or null when the configuration is unusable (the
// entrypoint then exits non-zero).
export function startup(env: Record<string, string | undefined>, deps: StartupDeps): McpServer | null {
  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      deps.log(`${BRAND.packageName}: ${err.message}`);
      deps.log(
        `${BRAND.packageName}: required: ${ENV.apiUrl}, ${ENV.token}, ${ENV.channel}. ` +
          `Optional: ${ENV.allowSend}=1 to enable sending.`,
      );
      return null;
    }
    throw err;
  }
  // The ORIGIN only: config accepts a path, and a path can carry a credential
  // (a key segment, or the token itself pasted there), which this line would
  // otherwise write to the MCP host's log on every start.
  deps.log(
    `${BRAND.packageName} ${SERVER_VERSION}: channel ${config.channel} at ${new URL(config.apiUrl).origin}, ` +
      `sending ${config.allowSend ? 'ENABLED' : `disabled (set ${ENV.allowSend}=1 to enable)`}`,
  );
  return createServer(config, { fetch: deps.fetch });
}
