import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SETUP_AGENT = 'dev-tools-setup';
export const SETUP_SERVER = 'ops-console';

export const SETUP_TOOLS = [
  'test_connection',
  'save_connection',
  'connect_connector',
  'authenticate_mcp_server',
  'request_secret',
] as const;

const DEFINITION = `---
name: ${SETUP_AGENT}
description: Sets up database Connections, Connectors and MCP Server sign-ins for Ops Console
tools: ${SETUP_TOOLS.map((tool) => `mcp__${SETUP_SERVER}__${tool}`).join(', ')}
---

You set up database Connections for the operator through the \`${SETUP_SERVER}\` tools. Nothing else.

- Work out the type (postgres, mongodb, redis, clickhouse, firebase, kafka), host, port, database, user, environment
  (local, dev, staging, prod) and Access Level from what the operator wrote. Ask for what is missing.
- A PROD Connection is read unless the operator asks for write.
- Secrets reach you as \`{{secret:<n>}}\`. Pass the placeholder on as it is, in the \`secret\` field. Never ask the
  operator to type a password into chat: call \`request_secret\` and use the placeholder it returns.
- Call \`test_connection\` before \`save_connection\`. Report a failed test and ask what to change.
- You can also connect a Connector (\`connect_connector\`) and start an MCP Server sign-in
  (\`authenticate_mcp_server\`). The operator finishes those in the browser.
- You cannot change or delete an existing Connection.
`;

/** The agent definition and the MCP config that gives it the console's tools, in the terminal's own folder. */
export async function writeSetupFiles(
  dir: string,
  options: { launcher: string; url: string; token: string; terminalId: string },
): Promise<{ mcpConfig: string }> {
  await mkdir(path.join(dir, '.claude', 'agents'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, '.claude', 'agents', `${SETUP_AGENT}.md`), DEFINITION);
  const mcpConfig = path.join(dir, 'mcp.json');
  await writeFile(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        [SETUP_SERVER]: {
          command: options.launcher,
          args: ['mcp-setup'],
          env: {
            OPS_CONSOLE_URL: options.url,
            OPS_CONSOLE_TOKEN: options.token,
            OPS_CONSOLE_TERMINAL: options.terminalId,
          },
        },
      },
    }),
    { mode: 0o600 },
  );
  await chmod(mcpConfig, 0o600);
  return { mcpConfig };
}
