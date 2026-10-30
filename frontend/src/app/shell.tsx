import { Navigate, Route, Routes } from 'react-router-dom';
import { Empty } from '../components/ui/empty';
import { useLiveEvents } from '../lib/live';
import { WorkspaceView } from '../workspace/workspace-view';
import { SettingsDrawer } from './settings-drawer';
import { TopBar, VIEWS } from './top-bar';

export function Shell() {
  useLiveEvents();
  return (
    <>
      <TopBar />
      <main className="flex min-h-0 flex-1">
        <Routes>
          <Route path="/workspace" element={<WorkspaceView />} />
          {VIEWS.filter((view) => view.path !== '/workspace').map((view) => (
            <Route key={view.path} path={view.path} element={<Empty>{view.label}: nothing here yet.</Empty>} />
          ))}
          <Route path="*" element={<Navigate to="/monitor" replace />} />
        </Routes>
      </main>
      <SettingsDrawer />
    </>
  );
}
