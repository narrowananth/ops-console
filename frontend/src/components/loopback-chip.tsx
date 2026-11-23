/** Marks a run that can start servers and reach every service on this Mac's localhost: the Loopback switch, when it started. */
export function LoopbackChip({ on }: { on: boolean }) {
  if (!on) return null;
  return (
    <span
      title="This run's commands can start servers and reach every service on this Mac's localhost."
      className="flex-none rounded-full bg-accent-100 px-2 py-px font-mono text-[10.5px] text-accent-700"
    >
      Loopback on
    </span>
  );
}
