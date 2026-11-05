import { describe, expect, it } from 'vitest';
import { GithubReleases } from '../src/updates/releases';

type Asked = { url: string; method: string };

/** GitHub as `GithubReleases` sees it: the latest page redirects to `tag`; the API answers `api` for a tag. */
function github(state: { tag: string; api: number }) {
  const asked: Asked[] = [];
  const get = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, method: init?.method ?? 'GET' });
    if (url.endsWith('/releases/latest')) {
      return new Response(null, {
        status: 302,
        headers: { location: `https://github.com/narrowananth/ops-console/releases/tag/${state.tag}` },
      });
    }
    if (state.api !== 200) return new Response('{}', { status: state.api });
    return Response.json({
      tag_name: state.tag,
      published_at: '2026-11-04T10:00:00Z',
      html_url: `https://github.com/narrowananth/ops-console/releases/tag/${state.tag}`,
      body: 'What changed',
    });
  }) as typeof fetch;
  return { asked, get };
}

describe('GithubReleases', () => {
  it('reads the newest tag from the latest page, and asks the API only for a tag not seen yet', async () => {
    const state = { tag: 'v0.1.11', api: 200 };
    const { asked, get } = github(state);
    const releases = new GithubReleases(get);

    expect(await releases.latest()).toEqual({
      version: '0.1.11',
      published_at: '2026-11-04T10:00:00Z',
      url: 'https://github.com/narrowananth/ops-console/releases/tag/v0.1.11',
      notes: 'What changed',
    });
    await releases.latest();
    expect(asked.map((call) => `${call.method} ${call.url}`)).toEqual([
      'HEAD https://github.com/narrowananth/ops-console/releases/latest',
      'GET https://api.github.com/repos/narrowananth/ops-console/releases/tags/v0.1.11',
      'HEAD https://github.com/narrowananth/ops-console/releases/latest',
    ]);

    state.tag = 'v0.1.12';
    expect((await releases.latest()).version).toBe('0.1.12');
    expect(asked.at(-1)?.url).toBe('https://api.github.com/repos/narrowananth/ops-console/releases/tags/v0.1.12');
  });

  it('still finds the version when the API turns it away, and asks for the notes again next time', async () => {
    const state = { tag: 'v0.1.12', api: 403 };
    const { asked, get } = github(state);
    const releases = new GithubReleases(get);

    expect(await releases.latest()).toEqual({
      version: '0.1.12',
      published_at: null,
      url: 'https://github.com/narrowananth/ops-console/releases/tag/v0.1.12',
      notes: null,
    });
    state.api = 200;
    expect((await releases.latest()).notes).toBe('What changed');
    expect(asked.filter((call) => call.url.includes('api.github.com'))).toHaveLength(2);
  });

  it('fails a check when the latest page does not point at a tag', async () => {
    const get = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    await expect(new GithubReleases(get).latest()).rejects.toThrow('GitHub answered 404 without the newest release');
  });

  it('asks again once when the first request is lost, and gives up when the second is lost too', async () => {
    const lost = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const { get } = github({ tag: 'v0.1.12', api: 200 });
    let calls = 0;
    const flaky = ((input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return Promise.reject(lost());
      return get(input, init);
    }) as typeof fetch;
    expect((await new GithubReleases(flaky, 0).latest()).version).toBe('0.1.12');

    const down = (() => Promise.reject(lost())) as typeof fetch;
    await expect(new GithubReleases(down, 0).latest()).rejects.toThrow('The operation was aborted due to timeout');
  });
});
