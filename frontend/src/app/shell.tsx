import { type ComponentType, lazy, type ReactNode, Suspense } from 'react';
import { Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { useHealthAlerts, useRunAlerts } from '../agent-runs/alerts';
import { Empty } from '../components/ui/empty';
import { useLiveEvents } from '../lib/live';
import { usePrefetchPullRequests } from '../lib/queries';
import { SetupAgentButton } from '../setup/setup-agent-link';
import { KeychainWaitBanner } from './keychain-wait';
import { lastPage, useKeepAddress } from './last-address';
import { Page, PageColumn } from './page';
import { ReturnButton } from './return-button';
import { Sidebar } from './sidebar';
import { UpdateNotice } from './updates';

/**
 * A page's code loads when the page opens, so the first screen carries only the shell and the page the operator
 * lands on. `named` picks the component a module exports by name.
 */
function load<M, K extends keyof M>(importer: () => Promise<M>, named: K) {
  return lazy(async () => ({ default: (await importer())[named] as ComponentType }));
}

const AgentRunsActions = load(() => import('../agent-runs/agent-runs-view'), 'AgentRunsActions');
const AgentRunsView = load(() => import('../agent-runs/agent-runs-view'), 'AgentRunsView');
const AgentsTab = load(() => import('../agents/agents-tab'), 'AgentsTab');
const DevToolsTab = load(() => import('../devtools/devtools-tab'), 'DevToolsTab');
const DevToolsView = load(() => import('../devtools/terminal-view'), 'DevToolsView');
const IntegrationsTab = load(() => import('../integrations/integrations-tab'), 'IntegrationsTab');
const MonitorView = load(() => import('../monitor/monitor-view'), 'MonitorView');
const NewPlaybookButton = load(() => import('../playbooks/playbooks-view'), 'NewPlaybookButton');
const PlaybooksView = load(() => import('../playbooks/playbooks-view'), 'PlaybooksView');
const ReposTab = load(() => import('../repos/repos-tab'), 'ReposTab');
const PermissionsTab = load(() => import('../setup/permissions-tab'), 'PermissionsTab');
const SetupAgentTab = load(() => import('../setup/setup-agent-tab'), 'SetupAgentTab');
const NewSkillButton = load(() => import('../skills/skills-view'), 'NewSkillButton');
const SkillsView = load(() => import('../skills/skills-view'), 'SkillsView');
const PullRequestsPage = load(() => import('../workspace/pull-requests-page'), 'PullRequestsPage');
const SessionsPage = load(() => import('../workspace/sessions-page'), 'SessionsPage');

/** A page's body while its code loads; the header's own buttons simply appear when theirs does. */
function Loading({ children }: { children: ReactNode }) {
  return <Suspense fallback={<Empty>Loading the page…</Empty>}>{children}</Suspense>;
}

/** A list page's body: one rounded card in a readable column. */
function Card({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <PageColumn wide={wide}>
      <div className="overflow-hidden rounded-xl border border-line bg-card shadow-sm">{children}</div>
    </PageColumn>
  );
}

/** An old `/workspace` link opens the page its `tab` named, with the Session or pull request it carried. */
function OldWorkspaceAddress() {
  const [params] = useSearchParams();
  const pulls = params.get('tab') === 'pulls';
  const item = params.get(pulls ? 'pr' : 'session');
  const query = item === null ? '' : `?${new URLSearchParams({ [pulls ? 'pr' : 'session']: item })}`;
  return <Navigate to={`${pulls ? '/pull-requests' : '/sessions'}${query}`} replace />;
}

export function Shell() {
  useLiveEvents();
  usePrefetchPullRequests();
  useKeepAddress();
  useRunAlerts();
  useHealthAlerts();
  return (
    <div className="flex min-h-0 flex-1">
      <Sidebar />
      <UpdateNotice />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <KeychainWaitBanner />
        <main className="flex min-h-0 min-w-0 flex-1">
          <Routes>
            <Route
              path="/monitor"
              element={
                <Page title="Monitor" sub="Log health of your services, their Alerts and fixes">
                  <Loading>
                    <MonitorView />
                  </Loading>
                </Page>
              }
            />
            <Route
              path="/sessions"
              element={
                <Page title="Sessions" sub="Your conversations with the agent in your Repos">
                  <Loading>
                    <SessionsPage />
                  </Loading>
                </Page>
              }
            />
            <Route
              path="/pull-requests"
              element={
                <Page title="Pull requests" sub="Open pull requests on your Git hosts">
                  <Loading>
                    <PullRequestsPage />
                  </Loading>
                </Page>
              }
            />
            <Route path="/workspace" element={<OldWorkspaceAddress />} />
            <Route
              path="/agent-runs"
              element={
                <Page
                  title="Agent runs"
                  sub="Every agent run: how it goes, why it is slow, why it failed"
                  width="xwide"
                  actions={
                    <Suspense fallback={null}>
                      <AgentRunsActions />
                    </Suspense>
                  }
                >
                  <Loading>
                    <AgentRunsView />
                  </Loading>
                </Page>
              }
            />
            <Route
              path="/devtools"
              element={
                <Page title="Dev tools" sub="Ask across your databases. PROD is read-only unless you allow write.">
                  <Loading>
                    <DevToolsView />
                  </Loading>
                </Page>
              }
            />
            <Route
              path="/integrations"
              element={
                <Page
                  title="Integrations"
                  sub="Connectors sign in to a service. MCP servers give Claude tools."
                  width="wide"
                  actions={<SetupAgentButton label="Add with Setup agent →" />}
                >
                  <Loading>
                    <IntegrationsTab />
                  </Loading>
                </Page>
              }
            />
            <Route
              path="/connections"
              element={
                <Page
                  title="Connections"
                  sub="Databases Dev tools and Claude can reach"
                  width="wide"
                  actions={<SetupAgentButton label="Import with Setup agent →" />}
                >
                  <Card wide>
                    <Loading>
                      <DevToolsTab />
                    </Loading>
                  </Card>
                </Page>
              }
            />
            <Route
              path="/repos"
              element={
                <Page title="Repos" sub="Local git folders Sessions work in" width="wide">
                  <Card wide>
                    <Loading>
                      <ReposTab />
                    </Loading>
                  </Card>
                </Page>
              }
            />
            <Route
              path="/setup"
              element={
                <Page title="Setup agent" sub="Claude adds Connections, MCP servers and Connectors for you">
                  <Loading>
                    <SetupAgentTab />
                  </Loading>
                </Page>
              }
            />
            <Route
              path="/permissions"
              element={
                <Page
                  title="Permissions"
                  sub="What macOS lets Ops Console do, and what an agent run's commands can reach"
                >
                  <Loading>
                    <PermissionsTab />
                  </Loading>
                </Page>
              }
            />
            <Route
              path="/agents"
              element={
                <Page
                  title="Accounts & Usage"
                  sub="Claude accounts, what they spent, notifications and defaults for every session"
                  width="narrow"
                >
                  <PageColumn>
                    <Loading>
                      <AgentsTab />
                    </Loading>
                  </PageColumn>
                </Page>
              }
            />
            <Route
              path="/playbooks"
              element={
                <Page
                  title="Playbooks"
                  sub="What the agent follows when each Trigger starts it. One Playbook per Trigger."
                  actions={
                    <Suspense fallback={null}>
                      <NewPlaybookButton />
                    </Suspense>
                  }
                >
                  <Loading>
                    <PlaybooksView />
                  </Loading>
                </Page>
              }
            />
            <Route
              path="/skills"
              element={
                <Page
                  title="Skills"
                  sub="Methods the agent can load while a Playbook runs. Attach them to Playbooks."
                  actions={
                    <>
                      <ReturnButton />
                      <Suspense fallback={null}>
                        <NewSkillButton />
                      </Suspense>
                    </>
                  }
                >
                  <Loading>
                    <SkillsView />
                  </Loading>
                </Page>
              }
            />
            <Route path="*" element={<Navigate to={lastPage()} replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
