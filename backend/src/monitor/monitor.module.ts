import { type DynamicModule, Module } from '@nestjs/common';
import { ConnectorId } from '@ops-console/shared';
import { STORE, type Store } from '../db/store';
import { KEYCHAIN, type Keychain } from '../keychain/keychain';
import { AlertSessions } from './alert-sessions';
import { AlertsService } from './alerts.service';
import { CloudWatchLogs, type CloudWatchOptions } from './cloudwatch-logs';
import { CliCodeHosts, CODE_HOSTS, CodeFinder, type CodeHosts } from './code-finder';
import { PupDatadog } from './datadog';
import { FixesService } from './fixes.service';
import { LOG_READERS, type LogReader, type LogReaders } from './log-reader';
import { cloudWatchLogsConfig, otelLogsConfig } from './log-source-config';
import { lokiAccess } from './loki-access';
import { LokiLogs, type LokiOptions } from './loki-logs';
import { MonitorController } from './monitor.controller';
import { OtelLogFolder } from './otel-logs';
import { MonitorRetention } from './retention';
import { ReviewsService } from './reviews.service';
import { ScansService } from './scans.service';
import { ServicesService } from './services.service';
import { VerificationsService } from './verifications.service';

/** Monitor: Scans of the log sources (Datadog, a Log folder, CloudWatch logs, Loki), Alerts, Verification, Review and Fix (ADR 0002). */
@Module({})
export class MonitorModule {
  static forRoot(
    config: {
      datadog?: LogReader;
      codeHosts?: CodeHosts;
      /** Bytes a Scan reads from the Log folder at most. */
      otelReadLimit?: number;
      /** How the CloudWatch source calls the `aws` CLI. */
      cloudWatch?: CloudWatchOptions;
      /** How the Loki source calls the `logcli` CLI. */
      loki?: LokiOptions;
    } = {},
  ): DynamicModule {
    return {
      module: MonitorModule,
      global: true,
      controllers: [MonitorController],
      providers: [
        {
          provide: LOG_READERS,
          inject: [STORE, KEYCHAIN],
          useFactory: (store: Store, keychain: Keychain): LogReaders => ({
            [ConnectorId.Datadog]: config.datadog ?? new PupDatadog(),
            [ConnectorId.OtelLogs]: new OtelLogFolder(() => otelLogsConfig(store.db).folder, config.otelReadLimit),
            [ConnectorId.CloudWatchLogs]: new CloudWatchLogs(() => {
              const { profile, region, log_groups } = cloudWatchLogsConfig(store.db);
              return { profile, region, log_groups };
            }, config.cloudWatch),
            [ConnectorId.LokiLogs]: new LokiLogs(() => lokiAccess(store.db, keychain), config.loki),
          }),
        },
        { provide: CODE_HOSTS, useValue: config.codeHosts ?? new CliCodeHosts() },
        CodeFinder,
        MonitorRetention,
        AlertsService,
        ServicesService,
        AlertSessions,
        ScansService,
        VerificationsService,
        FixesService,
        ReviewsService,
      ],
      exports: [ScansService, AlertsService, FixesService, ReviewsService],
    };
  }
}
