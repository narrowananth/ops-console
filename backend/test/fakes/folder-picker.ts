import type { FolderPicker } from '../../src/repos/folder-picker';

/** Answers the folder dialog with `next`: a path, or `null` for a closed dialog. */
export class FakeFolderPicker implements FolderPicker {
  next: string | null = null;
  async pick(): Promise<string | null> {
    return this.next;
  }
}
