import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { isNative } from './platform';

/**
 * Hand a file the app fetched (a payslip PDF, an attachment, a CSV export)
 * to the user — the one helper every download goes through.
 *
 * Web: the usual blob URL + <a download> (or a new tab when `open`).
 *
 * Android app: neither works inside a WebView — <a download> is ignored and
 * window.open(blobUrl) opens nothing, so every "Download" button silently
 * did nothing. The file is written to the app's cache directory and offered
 * through the system share sheet, from which the user can open it in a PDF
 * viewer, save it to Files/Drive, or send it on.
 */
export async function saveOrShareBlob(blob: Blob, filename: string, opts: { open?: boolean } = {}): Promise<void> {
  if (!isNative) {
    const url = URL.createObjectURL(blob);
    if (opts.open) {
      window.open(url, '_blank');
    } else {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      // Firefox ignores click() on a detached anchor, and revoking the URL in
      // the same tick can cancel the download before it starts.
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }

  const safeName = (filename || 'download').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 120);
  const { uri } = await Filesystem.writeFile({
    path: safeName,
    data: await blobToBase64(blob),
    directory: Directory.Cache,
  });
  try {
    await Share.share({ title: safeName, files: [uri], dialogTitle: opts.open ? 'Open with' : 'Save or share' });
  } catch (err: any) {
    // Dismissing the share sheet rejects with "Share canceled" — not an error.
    if (!/cancel/i.test(String(err?.message ?? err))) throw err;
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1)); // strip "data:...;base64,"
    };
    reader.readAsDataURL(blob);
  });
}
