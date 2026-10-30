import { AccessMode, Effort, Model } from '@ops-console/shared';
import type { DropdownOption } from '../components/ui/dropdown';

export const MODELS: DropdownOption<Model>[] = [
  { value: Model.Opus, label: 'Claude Opus 5.5', description: 'Most capable for complex, multi-step work' },
  { value: Model.Sonnet, label: 'Claude Sonnet 5.5', description: 'Balanced speed and capability for everyday coding' },
  { value: Model.Haiku, label: 'Claude Haiku 5.5', description: 'Fastest, for quick edits and lookups' },
  { value: Model.Fable, label: 'Claude Fable 5.1', description: 'Mythos-tier model, for the hardest problems' },
];

export const EFFORTS: DropdownOption<Effort>[] = [
  { value: Effort.Low, label: 'Low', description: 'Quick answers, least thinking' },
  { value: Effort.Medium, label: 'Medium', description: 'Some planning before acting' },
  { value: Effort.High, label: 'High', description: 'Plans and checks its work' },
  { value: Effort.XHigh, label: 'Extra high', description: 'Deeper reasoning on tricky changes' },
  { value: Effort.Max, label: 'Max', description: 'Longest reasoning budget' },
  { value: Effort.Ultrathink, label: 'Ultrathink', description: 'Maximum thinking for the hardest tasks' },
];

export const ACCESS_MODES: DropdownOption<AccessMode>[] = [
  { value: AccessMode.Supervised, label: 'Supervised', description: 'Asks before every edit and command' },
  {
    value: AccessMode.AcceptEdits,
    label: 'Auto-accept edits',
    description: 'Applies file edits; asks before running commands',
  },
  { value: AccessMode.Auto, label: 'Auto', description: 'Runs edits and safe commands; asks for risky ones' },
  { value: AccessMode.Full, label: 'Full access', description: 'Edits and runs commands without asking' },
];
