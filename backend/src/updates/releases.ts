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
const TIMEOUT_MS = 10_000;

const githubRelease = z.object({
  tag_name: z.string(),
  published_at: z.string().nullable(),
  html_url: z.string(),
  body: z.string().nullable(),
});

/** GitHub's latest release, read without signing in: 60 requests an hour, far more than a check every few hours. */
export class GithubReleases implements ReleaseSource {
  async latest(): Promise<Release> {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'ops-console' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 403 || response.status === 429) {
      throw new Error('GitHub limits how often it answers; the next check tries again');
    }
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    const release = githubRelease.parse(await response.json());
    return {
      version: release.tag_name.replace(/^v/, ''),
      published_at: release.published_at,
      url: release.html_url,
      notes: release.body?.trim() || null,
    };
  }
}
