import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AgentsTab } from '../agents/agents-tab';
import { DevToolsTab } from '../devtools/devtools-tab';
import { DevToolsView } from '../devtools/terminal-view';
import { IntegrationsTab } from '../integrations/integrations-tab';
import { useLiveEvents } from '../lib/live';
import { usePrefetchPullRequests } from '../lib/queries';
import { MonitorView } from '../monitor/monitor-view';
import { NewPlaybookButton, PlaybooksView } from '../playbooks/playbooks-view';
import { ReposTab } from '../repos/repos-tab';
import { SetupAgentButton } from '../setup/setup-agent-link';
import { SetupAgentTab } from '../setup/setup-agent-tab';
import { WorkspaceView } from '../workspace/workspace-view';
import { KeychainWaitBanner } from './keychain-wait';
import { lastPage, useKeepAddress } from './last-address';
import { Page, PageColumn } from './page';
import { Sidebar } from './sidebar';
import { UpdateNotice } from './updates';

/** A list page's body: one rounded card in a readable column. */
function Card({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <PageColumn wide={wide}>
      <div className="overflow-hidden rounded-xl border border-line bg-card shadow-sm">{children}</div>
    </PageColumn>
  );
}

export function Shell() {
  useLiveEvents();
  usePrefetchPullRequests();
  useKeepAddress();
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
                <Page title="Monitor" sub="Datadog health of your services, their Alerts and fixes">
                  <MonitorView />
                </Page>
              }
            />
            <Route
              path="/workspace"
              element={
                <Page title="Workspace" sub="Sessions in your Repos and their pull requests">
                  <WorkspaceView />
                </Page>
              }
            />
            <Route
              path="/devtools"
              element={
                <Page title="Dev tools" sub="Ask across your databases. PROD is read-only unless you allow write.">
                  <DevToolsView />
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
                  <IntegrationsTab />
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
                    <DevToolsTab />
                  </Card>
                </Page>
              }
            />
            <Route
              path="/repos"
              element={
                <Page title="Repos" sub="Local git folders Sessions work in" width="wide">
                  <Card wide>
                    <ReposTab />
                  </Card>
                </Page>
              }
            />
            <Route
              path="/setup"
              element={
                <Page title="Setup agent" sub="Claude adds Connections, MCP servers and Connectors for you">
                  <SetupAgentTab />
                </Page>
              }
            />
            <Route
              path="/agents"
              element={
                <Page
                  title="Agents & accounts"
                  sub="Claude Code accounts and defaults for every session"
                  width="narrow"
                >
                  <PageColumn>
                    <AgentsTab />
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
                  actions={<NewPlaybookButton />}
                >
                  <PlaybooksView />
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
