const KIND_TIPS = {
  Connector: 'A Connector: an outside service you sign in to here. It adds its MCP Server when it has one.',
  MCP: 'An MCP Server: a server registered in Claude Code that gives the agent tools. It signs no one in.',
};

/** Whether an Integrations row is a Connector or an MCP Server. */
export function KindLabel({ children }: { children: keyof typeof KIND_TIPS }) {
  return (
    <span
      title={KIND_TIPS[children]}
      className="rounded-full bg-neutral-200 px-1.75 py-0.5 text-xs font-semibold tracking-[0.06em] text-neutral-700 uppercase"
    >
      {children}
    </span>
  );
}
