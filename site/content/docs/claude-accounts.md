# Claude accounts and CLIProxy

The agent runs on a Claude account. The console keeps its own Claude accounts, and can instead send runs through CLIProxy.

## Claude accounts

A Claude account is one Claude subscription signed in on this Mac, named by its email, with its own 5-hour and weekly usage windows. Add each account once, in Accounts & Usage, in one of two ways:

- **In this browser.** The console opens Anthropic's sign-in.
- **By link.** For a Mac with no browser tab to spare: the console shows Anthropic's sign-in link, anyone opens it in any browser, and the one-time code Anthropic shows goes back to the console.

The agent runs under the active account. Accounts & Usage shows the tokens, the estimated cost, the runs and the subagents recorded for each account, by day, by kind of run and by subagent type.

## Moving between accounts

- **Auto-switch** moves the active account when its 5-hour usage reaches the threshold, and carries each Session's conversation over.
- **Smart usage** ranks accounts by the weekly quota left per day until the weekly reset, so quota that would go unused is used first. While it is on, the console moves to the top pick on its own.
- **Disabled accounts** are skipped by Use, Smart usage, Auto-switch and the retry after a limit. A disabled account stays signed in, and a run already going on it finishes.

## CLIProxy

With CLIProxy as the Claude account hub, runs send CLIProxy's API key to a CLIProxy server on this Mac, and CLIProxy picks the account and tracks the quota. Auto-switch and Smart usage pause. The CLIProxy address must be a loopback address, because every prompt and file the agent reads goes there. Runs through CLIProxy show as CLIProxy in Account usage.

## What works the same either way

Connectors, MCP Servers and the Google sign-in belong to the console, so they work with any Claude account and with CLIProxy on or off. Switching accounts doesn't lose them.
