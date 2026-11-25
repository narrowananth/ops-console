import { MAX_PASTED_FILE_BYTES, MAX_PASTED_FILES, type PastedFile } from '@ops-console/shared';

function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** The files of a paste or drop as the wire carries them; `skipped` counts those over the size or number limit. */
export async function readPastedFiles(files: File[]): Promise<{ files: PastedFile[]; skipped: number }> {
  const taken = files.filter((file) => file.size <= MAX_PASTED_FILE_BYTES).slice(0, MAX_PASTED_FILES);
  const read = await Promise.all(
    taken.map(async (file) => ({ name: file.name || 'file', type: file.type, data: await base64Of(file) })),
  );
  return { files: read, skipped: files.length - read.length };
}
