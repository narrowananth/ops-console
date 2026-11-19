import type { Store } from '../db/store';
import type { Keychain } from '../keychain/keychain';
import { lokiAccess, secretsOf } from '../monitor/loki-access';
import { type IntegrationInput, runCli } from './integration-cli';

/**
 * What `run_integration` runs for a classified command. `logcli` gets the Connector's address, tenant and secret in its
 * environment, read from the Keychain now, and the secret is cut from what it prints: the agent names none of them.
 */
export async function runIntegration(
  { db, keychain }: { db: Store['db']; keychain: Keychain },
  input: IntegrationInput,
  cwd: string,
): Promise<{ text: string; ok: boolean }> {
  if (input.cli !== 'logcli') return runCli(input.cli, input.args, cwd);
  const access = await lokiAccess(db, keychain);
  return runCli('logcli', input.args, cwd, { env: access.childEnv, secrets: secretsOf(access) });
}
