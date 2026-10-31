import { AgentsTab } from '../agents/agents-tab';
import { Sheet } from '../components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { DevToolsTab } from '../devtools/devtools-tab';
import { IntegrationsTab } from '../integrations/integrations-tab';
import { ReposTab } from '../repos/repos-tab';
import { SetupAgentTab } from '../setup/setup-agent-tab';
import { type SettingsTab, useUi } from './ui-store';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'agents', label: 'Agents' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'dev', label: 'Dev tools' },
  { id: 'repos', label: 'Repos' },
  { id: 'setup', label: 'Setup agent' },
];

export function SettingsDrawer() {
  const { settingsTab, closeSettings, setSettingsTab } = useUi();
  return (
    <Sheet open={settingsTab !== null} onOpenChange={(open) => !open && closeSettings()} title="Settings">
      <Tabs
        value={settingsTab ?? 'agents'}
        onValueChange={(tab) => setSettingsTab(tab as SettingsTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="grid grid-cols-5">
          {TABS.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {TABS.map((tab) => (
          <TabsContent key={tab.id} value={tab.id} className="flex-1 overflow-auto">
            {tab.id === 'agents' ? (
              <AgentsTab />
            ) : tab.id === 'integrations' ? (
              <IntegrationsTab />
            ) : tab.id === 'dev' ? (
              <DevToolsTab />
            ) : tab.id === 'repos' ? (
              <ReposTab />
            ) : (
              <SetupAgentTab />
            )}
          </TabsContent>
        ))}
      </Tabs>
    </Sheet>
  );
}
