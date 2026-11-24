// Preloaded through NODE_OPTIONS, so the CLI under test takes its Linux paths on any host.
Object.defineProperty(process, 'platform', { value: 'linux' });
