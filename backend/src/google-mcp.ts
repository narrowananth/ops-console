// `ops-console google-mcp <url>`: the Google bridge. Its own entry, so a start loads the relay and not the daemon.
import { runGoogleBridge } from './mcp/google-bridge';

process.exit(await runGoogleBridge(process.argv[2], process.env, process.stdin, process.stdout));
