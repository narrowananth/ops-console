// Moves the console's Keychain items under one service from the program that wrote them to another one, so the
// new program reads them without macOS asking for the login keychain password. The old program runs `take`, the
// new one `put`: `pnpm dev` when the dev app is new (`ops-console-dev`), and the installed daemon when it starts
// on a new version (`ops-console`). Secrets pass through pipes, never a file or a log.
//
//   <old program> keychain-handover.mjs take <service>   stdout: {"<account>": "<secret>", …}
//   <new program> keychain-handover.mjs put <service>    stdin: {"<account>": "<secret>", …}
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { AsyncEntry } from '@napi-rs/keyring';

/**
 * The accounts kept under `service` in the login Keychain; given `holder`, only those whose access list names it, so
 * reading them asks nothing. `dump-keychain -a` prints access lists, and without `-d` no secrets.
 */
export function consoleAccounts(service, holder = null) {
  const login = path.join(homedir(), 'Library/Keychains/login.keychain-db');
  const dump = execFileSync('security', ['dump-keychain', ...(holder === null ? [] : ['-a']), login], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const accounts = new Set();
  for (const block of dump.split(/^keychain: /m)) {
    if (!block.includes(`"svce"<blob>="${service}"`)) continue;
    if (holder !== null && !block.includes(`: ${holder} (`)) continue;
    const account = /"acct"<blob>="([^"]*)"/.exec(block)?.[1];
    if (account) accounts.add(account);
  }
  return [...accounts];
}

/** This program as access lists name it: its app bundle, or the bare executable. */
function holder() {
  const marker = '.app/Contents/MacOS/';
  const at = process.execPath.indexOf(marker);
  return at === -1 ? process.execPath : process.execPath.slice(0, at + '.app'.length);
}

/** Takes out the items this program holds; any other item stays, since reading it would ask for the password. */
async function take(service) {
  const accounts = consoleAccounts(service, holder());
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
  if (mode === 'take') process.stdout.write(JSON.stringify(await take(service)));
  else if (mode === 'put') await put(service, JSON.parse(readFileSync(0, 'utf8')));
  else throw new Error('usage: keychain-handover.mjs take | put <service>');
}
