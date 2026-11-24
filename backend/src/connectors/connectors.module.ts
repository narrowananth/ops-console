import { type DynamicModule, Module } from '@nestjs/common';
import { CONNECTOR_SERVERS, ConnectorId } from '@ops-console/shared';
import { KEYCHAIN, type Keychain } from '../keychain/keychain';
import { FOLDER_PICKER, type FolderPicker, folderPicker } from '../repos/folder-picker';
import { CLAUDE_CREDENTIALS, type ClaudeCredentials, MacClaudeCredentials } from './claude-credentials';
import { CONNECTOR_TOOLS, type ConnectorTools } from './connector-tools';
import { ConnectorsController } from './connectors.controller';
import { ConnectorsService } from './connectors.service';
import { GOOGLE_AUTH, type GoogleAuth, LoopbackGoogleAuth } from './google-auth';
import { GRAFANA_AUTH, type GrafanaAuth, LoopbackGrafanaAuth } from './grafana-auth';
import { HOSTED_HOSTS, type HostedHosts, HostedServers } from './hosted-servers';

/** The Connectors in Settings › Integrations. Other specs call `ConnectorsService.require` before an action that needs a Connector. */
@Module({})
export class ConnectorsModule {
  static forRoot(config: {
    tools: ConnectorTools;
    google?: GoogleAuth;
    /** How long Grafana's sign-in waits on the browser, in ms. */
    grafanaSignInMs?: number;
    /** What Claude Code stored for its MCP servers. */
    claudeCredentials?: ClaudeCredentials;
    hosts?: HostedHosts;
    /** The folder dialog of the OpenTelemetry pane. */
    folderPicker?: FolderPicker;
  }): DynamicModule {
    const hosts = config.hosts ?? {};
    return {
      module: ConnectorsModule,
      global: true,
      controllers: [ConnectorsController],
      providers: [
        { provide: CONNECTOR_TOOLS, useValue: config.tools },
        { provide: GOOGLE_AUTH, useValue: config.google ?? new LoopbackGoogleAuth(null) },
        {
          provide: GRAFANA_AUTH,
          inject: [KEYCHAIN],
          useFactory: (keychain: Keychain): GrafanaAuth =>
            new LoopbackGrafanaAuth(
              keychain,
              hosts.grafana ?? (CONNECTOR_SERVERS[ConnectorId.LokiLogs] as { target: string }).target,
              config.grafanaSignInMs,
            ),
        },
        { provide: CLAUDE_CREDENTIALS, useValue: config.claudeCredentials ?? new MacClaudeCredentials() },
        { provide: HOSTED_HOSTS, useValue: hosts },
        { provide: FOLDER_PICKER, useValue: config.folderPicker ?? folderPicker() },
        HostedServers,
        ConnectorsService,
      ],
      exports: [ConnectorsService, HostedServers],
    };
  }
}
