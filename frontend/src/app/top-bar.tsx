import { NavLink } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { useUi } from './ui-store';

export const VIEWS = [
  { path: '/monitor', label: 'Monitor' },
  { path: '/workspace', label: 'Workspace' },
  { path: '/devtools', label: 'Dev tools' },
] as const;

function Logo() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 32 32"
      role="img"
      aria-label="Ops Console logo"
      className="block flex-none"
    >
      <rect width="32" height="32" className="fill-accent" />
      <path d="M8 9.5l7 6.5-7 6.5" fill="none" className="stroke-white" strokeWidth="3.2" strokeLinecap="square" />
      <rect x="17" y="20" width="8" height="3.2" className="fill-white" />
      <rect x="25" y="4" width="3" height="3" className="fill-white" />
    </svg>
  );
}

export function TopBar() {
  const { theme, toggleTheme, openSettings } = useUi();
  return (
    <header className="flex min-h-13 flex-wrap items-center gap-5 border-b-2 border-divider px-4">
      <div className="flex items-center gap-2.5">
        <Logo />
        <div className="font-heading text-[17px] font-extrabold tracking-[-0.02em]">Ops Console</div>
      </div>
      <nav className="flex self-stretch">
        {VIEWS.map((view) => (
          <NavLink
            key={view.path}
            to={view.path}
            className={({ isActive }) =>
              `-mb-0.5 flex items-center gap-2 border-b-3 px-3.5 text-sm text-text no-underline hover:bg-neutral-200 hover:text-text ${
                isActive ? 'border-accent font-extrabold' : 'border-transparent'
              }`
            }
          >
            {view.label}
          </NavLink>
        ))}
      </nav>
      <div className="flex-1" />
      <Button
        icon
        variant="secondary"
        onClick={toggleTheme}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          {theme === 'dark' ? (
            <>
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </>
          ) : (
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
          )}
        </svg>
      </Button>
      <Button variant="secondary" className="px-3 py-1.5" onClick={() => openSettings()}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M20 7h-9M14 17H5" />
          <circle cx="17" cy="17" r="3" />
          <circle cx="7" cy="7" r="3" />
        </svg>
        Settings
      </Button>
    </header>
  );
}
