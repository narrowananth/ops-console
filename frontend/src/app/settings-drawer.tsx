import { Empty } from '../components/ui/empty';
import { Sheet } from '../components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { type SettingsTab, useUi } from './ui-store';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'agents', label: 'Agents' },
  { id: 'mcp', label: 'MCP servers' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'dev', label: 'Dev tools' },
  { id: 'repos', label: 'Repos' },
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
            <Empty>Nothing here yet.</Empty>
          </TabsContent>
        ))}
      </Tabs>
    </Sheet>
  );
}
