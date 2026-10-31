import { describe, expect, it } from 'vitest';
import { maskText } from '../src/terminals/secret-masking';

function masker() {
  const kept: string[] = [];
  const keep = (value: string) => {
    const known = kept.indexOf(value);
    if (known !== -1) return known + 1;
    kept.push(value);
    return kept.length;
  };
  return { kept, mask: (text: string, fileName?: string) => maskText(text, keep, fileName) };
}

describe('masking a file or a fetched page', () => {
  it('swaps the values of secret-named fields in .env, JSON, YAML and XML, and keeps the rest', () => {
    const { kept, mask } = masker();
    const text = [
      'DB_HOST=db.example.com',
      'DB_PASSWORD=hunter2',
      'export API_TOKEN="tok en"',
      '{ "name": "orders", "password": "j-son", "port": 5432 }',
      '  secret_key: yam1',
      '<Password>x-ml</Password>',
      'ssl_enabled: true',
    ].join('\n');
    expect(mask(text)).toBe(
      [
        'DB_HOST=db.example.com',
        'DB_PASSWORD={{secret:3}}',
        'export API_TOKEN="{{secret:1}}"',
        '{ "name": "orders", "password": "{{secret:2}}", "port": 5432 }',
        '  secret_key: {{secret:4}}',
        '<Password>{{secret:5}}</Password>',
        'ssl_enabled: true',
      ].join('\n'),
    );
    expect(kept).toEqual(['tok en', 'j-son', 'hunter2', 'yam1', 'x-ml']);
  });

  it('swaps the password of a URI, the last field of a .pgpass line and a whole private key', () => {
    const { kept, mask } = masker();
    expect(mask('url: mongodb+srv://reader:p%40ss@cluster.example.com/app')).toBe(
      'url: mongodb+srv://reader:{{secret:1}}@cluster.example.com/app',
    );
    expect(mask('# host:port:db:user:password\ndb.example.com:5432:orders:reader:pg:pass', '.pgpass')).toBe(
      '# host:port:db:user:password\ndb.example.com:5432:orders:reader:{{secret:2}}',
    );
    expect(mask('a\n-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\nb')).toBe(
      'a\n{{secret:3}}\nb',
    );
    expect(kept.slice(0, 2)).toEqual(['p%40ss', 'pg:pass']);
  });

  it('leaves a field that names a setting about the secret alone, as a desktop client stores beside it', () => {
    const { kept, mask } = masker();
    const text = [
      '{"credentialModeJson":"eyJtb2RlIjoiaW5saW5lIn0=","passwordFile":"~/.pgpass","tokenUrl":"https://example.com/t",',
      '"secretName":"orders-db","password":"real-one"}',
      'AUTH_TOKEN_TYPE=bearer',
    ].join('\n');
    expect(mask(text)).toBe(
      [
        '{"credentialModeJson":"eyJtb2RlIjoiaW5saW5lIn0=","passwordFile":"~/.pgpass","tokenUrl":"https://example.com/t",',
        '"secretName":"orders-db","password":"{{secret:1}}"}',
        'AUTH_TOKEN_TYPE=bearer',
      ].join('\n'),
    );
    expect(kept).toEqual(['real-one']);
  });

  it('leaves a placeholder already there, and an empty or boolean value, alone', () => {
    const { kept, mask } = masker();
    expect(mask('password={{secret:7}}\ntoken=""\nuse_password: false')).toBe(
      'password={{secret:7}}\ntoken=""\nuse_password: false',
    );
    expect(kept).toEqual([]);
  });
});
