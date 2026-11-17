// `ops-console mcp-exec <name> -- <command>`: the launcher for a stdio server whose env vars the console holds. Its own
// entry, so a start loads the Keychain and the launcher and not the whole daemon.
import { LoginKeychain } from './keychain/keychain';
import { runMcpExec } from './mcp/launcher';

process.exit(
  await runMcpExec(process.argv.slice(2), new LoginKeychain(process.env.OPS_CONSOLE_KEYCHAIN_SERVICE || undefined)),
);
