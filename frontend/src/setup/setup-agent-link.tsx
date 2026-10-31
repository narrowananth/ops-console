import { useUi } from '../app/ui-store';
import { Button } from '../components/ui/button';

/** The way from a tab the Setup agent can fill to the Setup agent tab. */
export function SetupAgentLink({ what }: { what: string }) {
  const openSettings = useUi((state) => state.openSettings);
  return (
    <div className="flex items-center gap-3 border-b border-divider px-5 py-2.5 text-xs text-neutral-700">
      <span className="flex-1">Or tell the Setup agent to add {what}.</span>
      <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => openSettings('setup')}>
        Open Setup agent →
      </Button>
    </div>
  );
}
