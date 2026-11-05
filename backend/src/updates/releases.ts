import type { Release } from '@ops-console/shared';
import { z } from 'zod';

export const RELEASES = Symbol('RELEASES');

/** Where new versions of the console come from. */
export interface ReleaseSource {
  /** The newest published release. */
  latest(): Promise<Release>;
}

/** The repository `install.sh` downloads from. */
const REPO = 'narrowananth/ops-console';
const TIMEOUT_MS = 15_000;
/** A request that fails on the network is tried once more after this long: a Wi-Fi switch or a wake from sleep passes. */
const RETRY_AFTER_MS = 3000;

const githubRelease = z.object({
  tag_name: z.string(),
  published_at: z.string().nullable(),
  html_url: z.string(),
  body: z.string().nullable(),
});

/**
 * GitHub's latest release, read without signing in. The page `releases/latest` redirects to the newest tag: asking for
 * it without following the redirect costs a few hundred bytes and no API quota, so it can run every minute. The API,
 * which allows 60 requests an hour, is asked only for a tag not seen yet, for its date and notes.
 */
export class GithubReleases implements ReleaseSource {
  private known: Release | null = null;

  constructor(
    private readonly get: typeof fetch = fetch,
    private readonly retryAfterMs = RETRY_AFTER_MS,
  ) {}

  async latest(): Promise<Release> {
    const tag = await this.newestTag();
    if (this.known && this.known.version === version(tag)) return this.known;
    const release = await this.release(tag);
    // Without its notes the release is asked for again at the next check.
    if (release.notes !== null || release.published_at !== null) this.known = release;
    return release;
  }

  private async newestTag(): Promise<string> {
    const ask = () =>
      this.get(`https://github.com/${REPO}/releases/latest`, {
        method: 'HEAD',
        redirect: 'manual',
        headers: { 'user-agent': 'ops-console' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    const response = await ask().catch(async () => {
      await new Promise((resolve) => setTimeout(resolve, this.retryAfterMs));
      return ask();
    });
    const tag = /\/releases\/tag\/([^/?#]+)$/.exec(response.headers.get('location') ?? '')?.[1];
    if (!tag) throw new Error(`GitHub answered ${response.status} without the newest release`);
    return decodeURIComponent(tag);
  }

  /** The tag's date and notes; when the API turns the console away, the version alone is enough to update. */
  private async release(tag: string): Promise<Release> {
    const page = `https://github.com/${REPO}/releases/tag/${encodeURIComponent(tag)}`;
    const response = await this.get(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'ops-console' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => null);
    const parsed = response?.ok ? githubRelease.safeParse(await response.json()) : null;
    if (!parsed?.success) return { version: version(tag), published_at: null, url: page, notes: null };
    const release = parsed.data;
    return {
      version: version(release.tag_name),
      published_at: release.published_at,
      url: release.html_url,
      notes: release.body?.trim() || null,
    };
  }
}

const version = (tag: string) => tag.replace(/^v/, '');
