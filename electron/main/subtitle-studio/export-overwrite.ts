import { app } from 'electron';
import { verifyLocalSubtitleOverwriteNativeAddon } from './transcription/native/overwrite-native-resource';
import { createLocalSubtitleOverwriteNativeRuntime } from './transcription/native/overwrite-native-backend';
import type { LocalSubtitleOverwriteTransactionRequest } from './transcription/native/overwrite-transaction';

/** New explicit overwrite uses the verified native directory-relative transaction. */
export async function prepareExportOverwrite() {
  const proof = await verifyLocalSubtitleOverwriteNativeAddon({ environment: app.isPackaged
    ? { mode: 'packaged', resourcesPath: process.resourcesPath }
    : { mode: 'development', appRoot: app.getAppPath() } });
  const { transactions } = createLocalSubtitleOverwriteNativeRuntime(proof);
  return (request: LocalSubtitleOverwriteTransactionRequest) => {
    const receipt = transactions.begin(request);
    // No renderer call or async gap between installation and finalization. The native
    // receipt retains the directory handle and recoverable victim until finalized.
    try { receipt.finalize(); receipt.acknowledge(); }
    catch (error) {
      if (receipt.state === 'open') { receipt.rollback(); receipt.acknowledge(); }
      // A pending terminal decision must never be reversed or its journal deleted.
      throw error;
    }
  };
}
