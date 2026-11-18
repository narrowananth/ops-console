# Terms of service

Effective 18 November 2026.

Ops Console is open-source software released under the [MIT License](LICENSE). By installing or using it you agree to these terms and to that license.

## What it is

A local web app for your Mac that runs on top of Claude Code. It shows your services, Alerts, databases, pull requests and Sessions. A coding agent you start in it can read and, within the limits you set, change code, files and the services you connect, such as Google Docs and Google Sheets.

## Your responsibilities

- **You direct the agent.** Each Session's Access mode decides whether the agent asks before it acts. In the most permissive mode it acts without asking. Read what it is about to do, and set the mode to suit the data it can reach.
- **Production is yours.** A command that writes to production data is yours to approve and run. Give the agent write access to a Connection only when you accept the result.
- **Check its work.** The console is built so that the agent does not merge pull requests and opens one only through the console. Review every change before you merge or deploy it.
- **Secure your Mac and accounts.** Anyone who can use your Mac or the console's session token can use everything the console is connected to.
- **Follow other terms.** Your use of each connected service, including [Google's Terms of Service](https://policies.google.com/terms), and of the AI provider behind your Claude account or CLIProxy, falls under their terms, not these.
- **Keep backups.** The agent can change documents, files and data you connected. Use version history and backups to recover.

## What you may do

Use, copy, change and share the software as the MIT License allows. Keep its copyright notice, and see `NOTICE` for text shipped from third parties under their own licenses.

## No warranty

The software is provided as is, without warranty of any kind, as the MIT License says. The project is not liable for data lost, changed or sent to a third party through the agent's actions or through the software, or for any other damage from using it. No support or availability is promised.

## Your data

[PRIVACY.md](PRIVACY.md) says what the software stores and what leaves your Mac. You can stop at any time by disconnecting a Connector or running `ops-console uninstall`.

## Changes and contact

The project may change these terms. The current text is in this repository, dated. Questions go to the project's [issue tracker](https://github.com/narrowananth/ops-console/issues).
