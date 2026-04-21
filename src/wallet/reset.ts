export type {
  WalletResetAction,
  WalletResetBitcoinDataDirResultStatus,
  WalletResetPreview,
  WalletResetResult,
  WalletResetSecretCleanupStatus,
  WalletResetSnapshotResultStatus,
} from "./reset/types.js";

import {
  previewResetWallet as previewResetWalletInternal,
} from "./reset/preview.js";
import {
  resetWallet as resetWalletInternal,
} from "./reset/execution.js";
import type {
  WalletResetExecutionOptions,
  WalletResetPreflightOptions,
  WalletResetPreview,
  WalletResetResult,
} from "./reset/types.js";

export async function previewResetWallet(
  options: WalletResetPreflightOptions,
): Promise<WalletResetPreview> {
  return await previewResetWalletInternal(options);
}

export async function resetWallet(
  options: WalletResetExecutionOptions,
): Promise<WalletResetResult> {
  return await resetWalletInternal(options);
}
