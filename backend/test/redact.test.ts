import { describe, expect, it } from 'vitest';
import { redact } from '../src/action-log/redact';

describe('redaction', () => {
  it.each([
    ['PGPASSWORD=hunter22 psql -h db.example.com', 'PGPASSWORD=[redacted] psql -h db.example.com'],
    ['psql postgres://app:s3cr3t@db.example.com/shop', 'psql postgres://app:[redacted]@db.example.com/shop'],
    [
      "curl -H 'Authorization: Bearer abcdef123456789' https://api.example.com",
      "curl -H 'Authorization: Bearer [redacted]' https://api.example.com",
    ],
    [
      'curl -H "X-Api-Key: 9f8e7d6c5b4a" https://api.example.com',
      'curl -H "X-Api-Key: [redacted]" https://api.example.com',
    ],
    ['deploy --token abc123def456', 'deploy --token [redacted]'],
    ['gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz0123', 'gh auth login --with-token [redacted]'],
    ['export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP', 'export AWS_ACCESS_KEY_ID=[redacted]'],
    ['echo xoxb-1234567890-abcdefghij', 'echo [redacted]'],
    ['ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop claude', 'ANTHROPIC_API_KEY=[redacted] claude'],
    ['mysql -u root -pS3cret shop', 'mysql -u root -p[redacted] shop'],
    ['execute_sql {"sql":"select 1","password":"pa\\"ss"}', 'execute_sql {"sql":"select 1","password":"[redacted]"}'],
  ])('redacts %s', (command, expected) => {
    expect(redact(command)).toBe(expected);
  });

  it.each([
    'git commit -m "fix login" --author "Operator <operator@example.com>"',
    'gh pr view 42 --json title',
    'SELECT id, email FROM customers WHERE id = 7',
    'ls -la src/auth',
  ])('leaves %s as it is', (command) => {
    expect(redact(command)).toBe(command);
  });
});
