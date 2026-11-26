import { runMcpExec } from '../../src/mcp/launcher';
import { NpmPackages } from '../../src/mcp/npm-packages';
import { FakeKeychain } from './keychain';

/**
 * `ops-console mcp-exec render -- <command> <args>` with the Keychain item the Render Connector writes, for a test that
 * drives the server over this process's stdio. `argv`: the packages folder, the Render header value, then the server's
 * command and arguments as the launcher is given them.
 */
const [packages, header, ...command] = process.argv.slice(2);
if (!packages || !header || command.length === 0) process.exit(2);
const keychain = new FakeKeychain();
await keychain.set('mcp:render', JSON.stringify({ RENDER_AUTH: header }));
process.exit(await runMcpExec(['render', '--', ...command], keychain, undefined, undefined, new NpmPackages(packages)));
