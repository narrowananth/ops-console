import type { Store } from '../db/store';
import type { Keychain } from '../keychain/keychain';
import { lokiAccess, secretsOf } from '../monitor/loki-access';
import { newRelicAccess, newRelicSecrets } from '../monitor/new-relic-access';
import { type IntegrationInput, runCli } from './integration-cli';

/**
 * What `run_integration` runs for a classified command. `logcli` and `newrelic` get the Connector's address or account
 * and secret in their environment, read from the Keychain now, and the secret is cut from what they print: the agent
 * names none of them.
 */
export async function runIntegration(
  { db, keychain }: { db: Store['db']; keychain: Keychain },
  input: IntegrationInput,
  cwd: string,
): Promise<{ text: string; ok: boolean }> {
  if (input.cli === 'logcli') {
    const access = await lokiAccess(db, keychain);
    return runCli('logcli', input.args, cwd, { env: access.childEnv, secrets: secretsOf(access) });
  }
  if (input.cli === 'newrelic') {
    const access = await newRelicAccess(db, keychain);
    // With no key the CLI would fall back to the operator's own ~/.newrelic profile.
    if (access.childEnv.NEW_RELIC_API_KEY === undefined) {
      return { text: 'New Relic logs is not connected: connect it in Integrations first.', ok: false };
    }
    return runCli('newrelic', input.args, cwd, { env: access.childEnv, secrets: newRelicSecrets(access) });
  }
  return runCli(input.cli, input.args, cwd);
}
