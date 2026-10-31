import { Navigate, Route, Routes } from 'react-router-dom';
import { DevToolsView } from '../devtools/terminal-view';
import { useLiveEvents } from '../lib/live';
import { MonitorView } from '../monitor/monitor-view';
import { WorkspaceView } from '../workspace/workspace-view';
import { SettingsDrawer } from './settings-drawer';
import { TopBar } from './top-bar';

export function Shell() {
  useLiveEvents();
  return (
    <>
      <TopBar />
      <main className="flex min-h-0 flex-1">
        <Routes>
          <Route path="/monitor" element={<MonitorView />} />
          <Route path="/workspace" element={<WorkspaceView />} />
          <Route path="/devtools" element={<DevToolsView />} />
          <Route path="*" element={<Navigate to="/monitor" replace />} />
        </Routes>
      </main>
      <SettingsDrawer />
    </>
  );
}
