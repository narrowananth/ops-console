import type { FolderPicker } from '../../src/repos/folder-picker';

/** Answers the folder dialog with `next`: the chosen paths, or none for a closed dialog. */
export class FakeFolderPicker implements FolderPicker {
  next: string[] = [];
  async pick(): Promise<string[]> {
    return this.next;
  }
}
