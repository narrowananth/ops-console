# OpenTelemetry logs are read from a folder, not received

The console reads OpenTelemetry logs from a Log folder on the Mac: OTLP JSON lines files (`.json` or `.jsonl`) that a Collector's `file` exporter writes. The operator chooses the folder with the macOS folder dialog, as on the Repos page, and types no path. The daemon pulls them on each Scan and runs no ingest endpoint. The server stays on `127.0.0.1` with its per-start session token ([ADR 0003](0003-local-only-server.md)), and a Collector holds no token that changes at every start.

A Log folder is a local source, so [ADR 0005](0005-claude-code-is-the-integration-layer.md) does not apply to it: no MCP server or CLI sits between the console and the files. The daemon reads them as the operator, read only. The agent has no tool for the folder and works from the Samples in its brief. The Run sandbox does not hide the folder, so a command the agent writes can read it, as it can read any file the operator can ([ADR 0006](0006-agent-runs-sandboxed-by-the-os.md)).

## Consequences

Logs are as fresh as the Collector's file and the last Scan. The operator runs a Collector on the same Mac and sets its exporter to plain JSON lines in one folder. Gzip, protobuf and subfolders are not read.

Records reach Anthropic's API as Samples in a prompt, like any text the agent reads.

A push receiver for OTLP or a webhook source needs its own ADR, because it rewrites ADR 0003.

## Considered Options

- **A receiver on loopback**: Collectors export to an OTLP endpoint with a fixed header, but the session token of ADR 0003 changes at every start. A stable ingest token amends that ADR.
- **A webhook receiver**: a service that pushes to the console needs an address it can reach, which means a tunnel or a relay. ADR 0003 forbids both.
- **A Monitor source concept beside Connectors**: a second place to connect a source. Integrations is the one place, so the Log folder is a Connector.
- **A folder tool for the agent**: a tool would need its own review of what it may read, and the Samples in the brief are enough to start from.
- **A typed path**: the operator had to know and spell the folder. The daemon is local ([ADR 0003](0003-local-only-server.md)), so its folder dialog opens on the operator's own screen.
