import { type Skill, SkillKind } from '@ops-console/shared';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { useUninstallPack } from '../lib/queries';
import { ascending } from '../lib/sort';
import { inWords } from '../playbooks/labels';

/** The Playbooks that hold any installed skill of the pack, A to Z. */
export function packHolders(skills: Skill[], packId: string | null): { id: string; name: string }[] {
  const byId = new Map(
    skills
      .filter((skill) => skill.kind === SkillKind.Builtin && skill.pack === packId)
      .flatMap((skill) => skill.playbooks)
      .map((playbook) => [playbook.id, playbook]),
  );
  return ascending([...byId.values()], (playbook) => playbook.name);
}

/** Asks before a pack goes: it names the Playbooks that lose skills. Jobs already running keep their copy. */
export function UninstallPackDialog(props: {
  packId: string;
  name: string;
  skillCount: number;
  holders: { id: string; name: string }[];
  onDone: () => void;
}) {
  const uninstall = useUninstallPack();
  const { holders } = props;
  const close = () => {
    uninstall.reset();
    props.onDone();
  };
  return (
    <ConfirmDialog
      title={`Uninstall ${props.name}?`}
      action="Uninstall"
      pending={uninstall.isPending}
      error={uninstall.error?.message}
      onConfirm={() => uninstall.mutate(props.packId, { onSuccess: props.onDone })}
      onCancel={close}
    >
      {`All ${props.skillCount} skills leave the / menu and the Playbook picker. `}
      {holders.length > 0 &&
        `${inWords(holders.map((playbook) => playbook.name))} hold skills of it and will lose them. Jobs already running keep their copy. `}
    </ConfirmDialog>
  );
}
