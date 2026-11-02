// Moves the console's Keychain items (service `ops-console`) from the program that wrote them to another one, so
// the new program reads them without macOS asking for the login keychain password. `pnpm dev` runs it when the dev
// app is new: the old program runs `take`, the new one `put`. Secrets pass through pipes, never a file or a log.
//
//   <old program> keychain-handover.mjs take   stdin: ["<account>", …]   stdout: {"<account>": "<secret>", …}
//   <new program> keychain-handover.mjs put    stdin: {"<account>": "<secret>", …}
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { AsyncEntry } from '@napi-rs/keyring';

const SERVICE = 'ops-console';

/** The accounts the console keeps in the login Keychain. `dump-keychain` without `-d` prints no secrets. */
export function consoleAccounts() {
  const dump = execFileSync('security', ['dump-keychain'], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  const accounts = new Set();
  for (const block of dump.split(/^keychain: /m)) {
    if (!block.includes(`"svce"<blob>="${SERVICE}"`)) continue;
    const account = /"acct"<blob>="([^"]*)"/.exec(block)?.[1];
    if (account) accounts.add(account);
  }
  return [...accounts];
}

async function take(accounts) {
  const secrets = {};
  // Every read first, so a refused one leaves every item where it was.
  for (const account of accounts) {
    const secret = await new AsyncEntry(SERVICE, account).getPassword();
    if (secret != null) secrets[account] = secret;
  }
  const deleted = [];
  try {
    for (const account of Object.keys(secrets)) {
      await new AsyncEntry(SERVICE, account).deletePassword();
      deleted.push(account);
    }
  } catch (error) {
    for (const account of deleted) await new AsyncEntry(SERVICE, account).setPassword(secrets[account]);
    throw error;
  }
  return secrets;
}

async function put(secrets) {
  for (const [account, secret] of Object.entries(secrets)) await new AsyncEntry(SERVICE, account).setPassword(secret);
}

if (import.meta.main) {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (process.argv[2] === 'take') process.stdout.write(JSON.stringify(await take(input)));
  else if (process.argv[2] === 'put') await put(input);
  else throw new Error('usage: keychain-handover.mjs take | put');
}
