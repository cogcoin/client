import type {
  RpcFinalizePsbtResult,
  RpcTransaction,
  RpcWalletProcessPsbtResult,
} from "../../bitcoind/types.js";
import {
  MANAGED_CORE_WALLET_UNLOCK_TIMEOUT_SECONDS,
  withUnlockedManagedCoreWallet,
} from "../managed-core-wallet.js";
import type {
  WalletStateV1,
} from "../types.js";
import type { WalletMutationRpcClient } from "./types.js";

export async function signAndFinalizeWalletMutation(options: {
  rpc: WalletMutationRpcClient;
  walletName: string;
  state: WalletStateV1;
  psbt: string;
  finalizeErrorCode: string;
  mempoolRejectPrefix: string;
  recoverManagedCoreWalletLockedOnce?: boolean;
  onManagedCoreWalletLockedRecoveryOutcome?: (outcome: "recovered" | "still-locked") => void;
}): Promise<{
  signed: RpcWalletProcessPsbtResult;
  finalized: RpcFinalizePsbtResult;
  rawHex: string;
  decodedRaw: RpcTransaction;
}> {
  return withUnlockedManagedCoreWallet({
    rpc: options.rpc,
    walletName: options.walletName,
    internalPassphrase: options.state.managedCoreWallet.internalPassphrase,
    timeoutSeconds: MANAGED_CORE_WALLET_UNLOCK_TIMEOUT_SECONDS,
    recoverLockedWalletOnce: options.recoverManagedCoreWalletLockedOnce,
    onLockedWalletRecoveryOutcome: options.onManagedCoreWalletLockedRecoveryOutcome,
    run: async () => {
      const signed = await options.rpc.walletProcessPsbt(options.walletName, options.psbt, true, "DEFAULT");
      const finalized = await options.rpc.finalizePsbt(signed.psbt, true);

      if (!finalized.complete || finalized.hex == null) {
        throw new Error(options.finalizeErrorCode);
      }

      const rawHex = finalized.hex;
      const decodedRaw = await options.rpc.decodeRawTransaction(rawHex);
      const mempoolResult = await options.rpc.testMempoolAccept([rawHex]);
      const accepted = mempoolResult[0];

      if (accepted == null || !accepted.allowed) {
        throw new Error(`${options.mempoolRejectPrefix}_${accepted?.["reject-reason"] ?? "unknown"}`);
      }

      return {
        signed,
        finalized,
        rawHex,
        decodedRaw,
      };
    },
  });
}
