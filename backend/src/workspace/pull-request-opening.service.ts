import { Inject, Injectable } from '@nestjs/common';
import {
  ActionActor,
  ActionKind,
  ActionOutcome,
  ConnectorId,
  ErrorCode,
  GitHost,
  type OpenPullRequest,
  PR_DESCRIPTION_RULE,
  PrState,
  type PullRequestDraft,
  SessionKind,
  type SessionPullRequest,
} from '@ops-console/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { ActionLogService } from '../action-log/action-log.service';
import { type OpenPullRequestInput, type PullRequestOpener } from '../agent/pull-request-tool';
import { AgentRuntime } from '../agent/runtime';
import { SessionsService } from '../agent/sessions.service';
import { parseAgentJson } from '../common/agent-json';
import { ApiError, validationFailed } from '../common/errors';
import { ConnectorsService } from '../connectors/connectors.service';
import { repos } from '../db/schema';
import { STORE, type Store } from '../db/store';
import { BranchMoved, GIT, Git, GitFailed } from '../repos/git';
import { GIT_HOSTS, type GitHosts } from './git-host';
import { PullRequestsService } from './pull-requests.service';

const CONNECTORS: Partial<Record<GitHost, ConnectorId>> = {
  [GitHost.Github]: ConnectorId.Github,
  [GitHost.Gitlab]: ConnectorId.Gitlab,
  [GitHost.Bitbucket]: ConnectorId.Bitbucket,
};

const draftAnswerSchema = z.object({ title: z.string(), description: z.string() });

export type PublishInput = {
  /** The Session whose Action Log gets the rows. */
  sessionId: string;
  /** The folder with the branch: a Repo's, or an anonymous Session's clone. */
  dir: string;
  /** The Repo, when the folder is one; its cached pull request list is dropped after an opening. */
  repoId: string | null;
  /** The Git host and `owner/name` of `origin`, as the Repo holds them; an anonymous Session's, read from its clone. */
  remote: { host: GitHost; slug: string | null };
  branch: string;
  base: string;
  title: string;
  body: string;
};

export type Published = { number: number; url: string; created: boolean };

/**
 * Pushing a branch and opening its pull request. The agent only commits and writes the text; the console does the
 * rest in the daemon, outside the Run sandbox, as the operator (ADR 0005, ADR 0006). Same steps for every Git host.
 */
@Injectable()
export class PullRequestOpeningService implements PullRequestOpener {
  /** Openings under way, so a second click on one branch waits for the first and gets its pull request. */
  private readonly inflight = new Map<string, Promise<Published>>();

  constructor(
    @Inject(STORE) private readonly store: Store,
    @Inject(GIT) private readonly git: Git,
    @Inject(GIT_HOSTS) private readonly hosts: GitHosts,
    @Inject(SessionsService) private readonly sessions: SessionsService,
    @Inject(ActionLogService) private readonly actionLog: ActionLogService,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(PullRequestsService) private readonly pulls: PullRequestsService,
    @Inject(AgentRuntime) private readonly runtime: AgentRuntime,
  ) {
    runtime.setPullRequestOpener(this);
  }

  /** What the Session's header shows: the open pull request, or whether one can be opened. */
  async status(sessionId: string): Promise<SessionPullRequest> {
    const none: SessionPullRequest = { can_open: false, pull_request: null, base_branch: null, uncommitted_files: 0 };
    const found = this.target(sessionId);
    if (!found) return none;
    const { repo, branch } = found;
    if (repo.host === GitHost.Local || repo.remoteSlug === null || !this.hosts.supports(repo.host)) return none;
    const base = repo.defaultBranch;
    const open = await this.openFor(repo.id, branch);
    const checkedOut = (await this.git.currentBranch(repo.path)) === branch;
    const ahead = branch === base ? 0 : await this.git.commitsAhead(repo.path, base, branch);
    return {
      can_open: open === null && ahead > 0,
      pull_request: open,
      base_branch: base,
      uncommitted_files: checkedOut ? await this.git.uncommittedFiles(repo.path) : 0,
    };
  }

  /** The agent's title and description from the Session's diff. Nothing changes; a failed turn gives empty fields. */
  async draft(sessionId: string, requestedBase?: string): Promise<PullRequestDraft> {
    const found = await this.openable(sessionId, requestedBase);
    const base = requestedBase ?? found.repo.defaultBranch;
    const prompt = `Write the pull request for branch ${found.branch} against ${base}. Read the commits and the diff with \`git log ${base}..${found.branch}\` and \`git diff ${base}...${found.branch}\`. ${PR_DESCRIPTION_RULE}
Change nothing: no commit, no push, no pull request. The console pushes and opens it once the operator confirms. Answer with one JSON block and nothing after it.

\`\`\`json
{ "title": "short title", "description": "markdown description" }
\`\`\``;
    try {
      const summary = await this.runtime.runFor(sessionId, prompt).finished;
      const parsed = summary.ok ? parseAgentJson(summary.text, draftAnswerSchema) : null;
      return parsed
        ? { title: parsed.title.trim(), description: parsed.description }
        : { title: null, description: null };
    } catch (error) {
      // A run already going keeps the Session; the operator waits for it.
      if (error instanceof ApiError && error.code === ErrorCode.SessionBusy) throw error;
      return { title: null, description: null };
    }
  }

  /** The agent may ask in a Session's own Repo folder, on a Git host the console can open on. */
  offers(sessionId: string, dir: string): boolean {
    const found = this.target(sessionId);
    return (
      found !== null &&
      found.repo.path === dir &&
      found.repo.host !== GitHost.Local &&
      found.repo.remoteSlug !== null &&
      this.hosts.supports(found.repo.host)
    );
  }

  /** What the operator reads before approving the agent's request. */
  async describe(sessionId: string, input: OpenPullRequestInput): Promise<string> {
    const { repo, branch, base } = await this.resolve(sessionId, input);
    return `Push ${branch} and open a pull request into ${base} on ${repo.host}: "${input.title}"`;
  }

  /** The agent's request, after the operator approved it. */
  async open(sessionId: string, input: OpenPullRequestInput): Promise<Published> {
    const { branch, base } = await this.resolve(sessionId, input);
    return this.openBranch(sessionId, branch, {
      title: input.title,
      description: input.description,
      base_branch: base,
    });
  }

  /** The branch the agent means (the one checked out in the Repo's folder unless it names another) and its base. */
  private async resolve(sessionId: string, input: OpenPullRequestInput) {
    const found = this.target(sessionId);
    if (!found) throw new ApiError(409, ErrorCode.InvalidState, 'Only a Session in a Repo opens a pull request');
    const branch = input.branch ?? (await this.git.currentBranch(found.repo.path)) ?? found.branch;
    const base = input.base_branch ?? found.repo.defaultBranch;
    await this.openable(sessionId, base, branch);
    return { repo: found.repo, branch, base };
  }

  /** Pushes the Session's branch and opens its pull request. An open one for the branch is returned, not duplicated. */
  async openFromUi(sessionId: string, input: OpenPullRequest): Promise<Published> {
    return this.openBranch(sessionId, undefined, input);
  }

  private async openBranch(
    sessionId: string,
    onBranch: string | undefined,
    input: OpenPullRequest,
  ): Promise<Published> {
    const { repo, branch } = await this.openable(sessionId, input.base_branch, onBranch);
    return this.publish({
      sessionId,
      dir: repo.path,
      repoId: repo.id,
      remote: { host: repo.host, slug: repo.remoteSlug },
      branch,
      base: input.base_branch,
      title: input.title,
      body: input.description,
    });
  }

  async publish(input: PublishInput): Promise<Published> {
    const key = `${input.dir}:${input.branch}`;
    const running = this.inflight.get(key);
    if (running) return { ...(await running), created: false };
    const work = this.run(input).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  private async run(input: PublishInput): Promise<Published> {
    const { remote } = input;
    const slug = remote.slug;
    if (remote.host === GitHost.Local || slug === null || !this.hosts.supports(remote.host)) {
      throw new ApiError(
        409,
        ErrorCode.InvalidState,
        'origin is not on a Git host the console can open a pull request on',
      );
    }
    const connector = CONNECTORS[remote.host];
    if (connector) this.connectors.require(connector);
    const adapter = this.hosts.for(remote.host);
    try {
      await this.git.remoteHead(input.dir, input.base);
    } catch (error) {
      const why = error instanceof GitFailed ? error.message : '';
      // Origin answered and has no such branch; any other failure is origin not answering.
      if (/couldn't find remote ref|^no origin\//.test(why)) {
        throw validationFailed(`base branch ${input.base} is not on origin`);
      }
      throw new ApiError(502, ErrorCode.UpstreamFailed, why || 'could not read origin');
    }
    await this.logged(
      input.sessionId,
      ActionKind.Git,
      `${slug}#${input.branch}`,
      `git push origin ${input.branch}`,
      async () => {
        try {
          await this.git.pushHead(input.dir, input.branch, `refs/heads/${input.branch}`);
        } catch (error) {
          if (error instanceof BranchMoved) {
            throw new ApiError(409, ErrorCode.BranchMoved, 'Branch moved on origin: nothing was pushed');
          }
          throw new ApiError(
            502,
            ErrorCode.UpstreamFailed,
            error instanceof GitFailed && error.message ? error.message : 'git push failed',
          );
        }
      },
    );
    // A retry, a second browser or a Fix retry finds the pull request the first call opened.
    const open = (await adapter.list(slug, PrState.Open)).find((pr) => pr.branch === input.branch);
    // The header reads the kept list: forget it, so it shows the link at once.
    if (input.repoId) this.pulls.drop(input.repoId);
    if (open) return { number: open.number, url: open.url, created: false };
    const made = await this.logged(
      input.sessionId,
      ActionKind.Pr,
      `${slug}#${input.branch}`,
      `open pull request ${input.branch} -> ${input.base}`,
      async () => {
        try {
          return await adapter.open(slug, {
            title: input.title,
            body: input.body,
            head: input.branch,
            base: input.base,
          });
        } catch (error) {
          // The host's own refusal or rate limit says what happened; anything else is a failed host call.
          if (error instanceof ApiError && error.status !== 404) throw error;
          throw new ApiError(
            502,
            ErrorCode.UpstreamFailed,
            error instanceof ApiError ? error.message : 'the Git host did not open the pull request',
          );
        }
      },
    );
    if (input.repoId) this.pulls.drop(input.repoId);
    return { ...made, created: true };
  }

  /** The Action Log row exists before the work; a failure finishes it with the reason. */
  private async logged<T>(
    sessionId: string,
    kind: ActionKind,
    target: string,
    command: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const row = this.actionLog.start({ sessionId, kind, target, command, isProd: false, actor: ActionActor.Operator });
    try {
      const result = await action();
      this.actionLog.finish(row, ActionOutcome.Ok);
      return result;
    } catch (error) {
      this.actionLog.finish(row, ActionOutcome.Failed, error instanceof Error ? error.message : 'failed');
      throw error;
    }
  }

  /** The pull request open for `branch`, read from the kept list; null when none, or when the host cannot be read. */
  private async openFor(repoId: string, branch: string): Promise<{ number: number; url: string } | null> {
    try {
      const list = await this.pulls.list({ repo_id: repoId, state: PrState.Open });
      const found = list.data.find((pr) => pr.branch === branch);
      return found ? { number: found.number, url: found.url } : null;
    } catch {
      return null;
    }
  }

  /** The Repo and branch of a `repo` Session, or null for any other Session. */
  private target(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session.kind !== SessionKind.Repo || session.repoId === null || session.branch === null) return null;
    const repo = this.store.db
      .select()
      .from(repos)
      .where(and(eq(repos.id, session.repoId), isNull(repos.removedAt)))
      .get();
    return repo ? { repo, branch: session.branch } : null;
  }

  /** The Session's Repo and branch, or `invalid_state` when no pull request can open from it. */
  private async openable(sessionId: string, base?: string, onBranch?: string) {
    const target = this.target(sessionId);
    if (!target) throw new ApiError(409, ErrorCode.InvalidState, 'Only a Session in a Repo opens a pull request');
    const found = { repo: target.repo, branch: onBranch ?? target.branch };
    const { repo, branch } = found;
    if (repo.host === GitHost.Local || repo.remoteSlug === null || !this.hosts.supports(repo.host)) {
      throw new ApiError(
        409,
        ErrorCode.InvalidState,
        'origin is not on a Git host the console can open a pull request on',
      );
    }
    if (branch === repo.defaultBranch) {
      throw new ApiError(409, ErrorCode.InvalidState, `${branch} is the default branch: nothing to open`);
    }
    // Another base may not be in the Repo yet; the push and the host judge that one.
    if (
      (base === undefined || base === repo.defaultBranch) &&
      (await this.git.commitsAhead(repo.path, repo.defaultBranch, branch)) === 0
    ) {
      throw new ApiError(
        409,
        ErrorCode.InvalidState,
        `${branch} has no commits ${repo.defaultBranch} lacks: nothing to open`,
      );
    }
    return found;
  }
}
