// Moves the dev console's Keychain items (one service, `ops-console-dev`) from the program that wrote them to another one, so
// the new program reads them without macOS asking for the login keychain password. `pnpm dev` runs it when the dev
// app is new: the old program runs `take`, the new one `put`. Secrets pass through pipes, never a file or a log.
//
//   <old program> keychain-handover.mjs take <service>   stdin: ["<account>", …]   stdout: {"<account>": "<secret>", …}
//   <new program> keychain-handover.mjs put <service>    stdin: {"<account>": "<secret>", …}
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { AsyncEntry } from '@napi-rs/keyring';

/** The accounts kept under `service` in the login Keychain. `dump-keychain` without `-d` prints no secrets. */
export function consoleAccounts(service) {
  const dump = execFileSync('security', ['dump-keychain'], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  const accounts = new Set();
  for (const block of dump.split(/^keychain: /m)) {
    if (!block.includes(`"svce"<blob>="${service}"`)) continue;
    const account = /"acct"<blob>="([^"]*)"/.exec(block)?.[1];
    if (account) accounts.add(account);
  }
  return [...accounts];
}

async function take(service, accounts) {
  const secrets = {};
  // Every read first, so a refused one leaves every item where it was.
  for (const account of accounts) {
    const secret = await new AsyncEntry(service, account).getPassword();
    if (secret != null) secrets[account] = secret;
  }
  const deleted = [];
  try {
    for (const account of Object.keys(secrets)) {
      await new AsyncEntry(service, account).deletePassword();
      deleted.push(account);
    }
  } catch (error) {
    for (const account of deleted) await new AsyncEntry(service, account).setPassword(secrets[account]);
    throw error;
  }
  return secrets;
}

async function put(service, secrets) {
  for (const [account, secret] of Object.entries(secrets)) await new AsyncEntry(service, account).setPassword(secret);
}

if (import.meta.main) {
  const [mode, service] = process.argv.slice(2);
  if (!service) throw new Error('usage: keychain-handover.mjs take | put <service>');
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (mode === 'take') process.stdout.write(JSON.stringify(await take(service, input)));
  else if (mode === 'put') await put(service, input);
  else throw new Error('usage: keychain-handover.mjs take | put <service>');
}
