import { ConnectionType } from '@ops-console/shared';
import { describe, expect, it } from 'vitest';
import { connectionHosts } from '../src/network/connection-hosts';

describe('connectionHosts', () => {
  it('reads a database host, lowercase, and drops localhost and IP addresses', () => {
    expect(connectionHosts(ConnectionType.Postgres, { host: ' DB.Example.com ' })).toEqual(['db.example.com']);
    expect(connectionHosts(ConnectionType.Redis, { host: 'localhost' })).toEqual([]);
    expect(connectionHosts(ConnectionType.Clickhouse, { host: '10.0.0.5' })).toEqual([]);
  });

  it('reads every Kafka bootstrap server and the two URLs', () => {
    expect(
      connectionHosts(ConnectionType.Kafka, {
        bootstrap_servers: 'b1.example.com:9092,b2.example.com:9092',
        schema_registry_url: 'https://registry.example.com:8081',
        kafbat_url: '',
      }),
    ).toEqual(['b1.example.com', 'b2.example.com', 'registry.example.com']);
  });

  it('gives a Firebase project the Google hosts and a MongoDB Connection none', () => {
    expect(connectionHosts(ConnectionType.Firebase, { project_id: 'p', services: [] })).toContain('*.googleapis.com');
    expect(connectionHosts(ConnectionType.Mongodb, { database: 'x' })).toEqual([]);
  });
});
