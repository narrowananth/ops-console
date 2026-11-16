import { describe, expect, it } from 'vitest';
import { agentMayOpen, isLoopbackHost, normalizeAddress } from '../src/browser/addresses';

describe('the operator address field', () => {
  it.each([
    ['localhost:5173', 'http://localhost:5173/'],
    ['3000', 'http://localhost:3000/'],
    ['127.0.0.1:3000/path?x=1', 'http://127.0.0.1:3000/path?x=1'],
    ['127.0.0.1', 'http://127.0.0.1/'],
    ['[::1]:3000', 'http://[::1]:3000/'],
    ['foo.localhost:8080', 'http://foo.localhost:8080/'],
    ['http://localhost:4545', 'http://localhost:4545/'],
    ['https://example.com/a%20b', 'https://example.com/a%20b'],
    ['example.com', 'https://example.com/'],
    ['staging.example.com:8443/app', 'https://staging.example.com:8443/app'],
    ['  http://example.com  ', 'http://example.com/'],
  ])('reads %s as %s', (input, address) => {
    expect(normalizeAddress(input)).toBe(address);
  });

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'chrome://settings',
    'mailto:someone@example.com',
    'data:text/html,hi',
    'ftp://example.com',
    'two words',
    'http://exa mple.com',
    '',
    '   ',
    '0',
    '70000',
  ])('refuses %j', (input) => {
    expect(normalizeAddress(input)).toBeNull();
  });
});

describe('what the agent may open', () => {
  it.each([
    'http://localhost:5173/',
    'http://127.0.0.1:3000/x',
    'http://[::1]:3000/',
    'http://app.localhost:8080/',
    'https://localhost/',
    'http://localhost/',
  ])('allows %s', (address) => {
    expect(agentMayOpen(address)).toBe(true);
  });

  it.each([
    'https://example.com/',
    'http://192.168.1.5:3000/',
    'http://localhost.example.com:3000/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
    'http://localhost:4545/',
    'http://127.0.0.1:4555/',
    'http://[::1]:4556/x',
  ])('refuses %s', (address) => {
    expect(agentMayOpen(address)).toBe(false);
  });

  it('knows the loopback hosts', () => {
    expect(['localhost', 'LOCALHOST', '127.0.0.1', '127.0.0.2', '[::1]', 'x.localhost'].every(isLoopbackHost)).toBe(
      true,
    );
    expect(isLoopbackHost('example.com')).toBe(false);
  });
});
