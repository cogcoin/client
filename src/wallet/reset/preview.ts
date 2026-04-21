import { createDefaultWalletSecretProvider } from "../state/provider.js";
import { resolveWalletRuntimePathsForTesting } from "../runtime.js";

import { resolveRemovedRoots } from "./artifacts.js";
import { preflightReset, resetDeletesOsSecrets } from "./preflight.js";
import type {
  WalletResetPreview,
  WalletResetPreflightOptions,
} from "./types.js";

export async function previewResetWallet(
  options: WalletResetPreflightOptions,
): Promise<WalletResetPreview> {
  const provider = options.provider ?? createDefaultWalletSecretProvider();
  const paths = options.paths ?? resolveWalletRuntimePathsForTesting();
  const preflight = await preflightReset({
    ...options,
    provider,
    paths,
  });
  const removedPaths = resolveRemovedRoots(paths, {
    preserveBitcoinDataDir: preflight.snapshot.status === "valid" && preflight.bitcoinDataDir.shouldPrompt,
  });

  return {
    dataRoot: preflight.dataRoot,
    confirmationPhrase: "permanently reset",
    walletPrompt: preflight.wallet.present
      ? {
        defaultAction: "retain-mnemonic",
        acceptedInputs: ["", "skip", "clear wallet entropy"],
        entropyRetainingResetAvailable: preflight.wallet.mode === "provider-backed",
        envelopeSource: preflight.wallet.envelopeSource,
      }
      : null,
    bootstrapSnapshot: {
      status: preflight.snapshot.status,
      path: preflight.snapshot.path,
      defaultAction: preflight.snapshot.status === "valid" ? "preserve" : "delete",
    },
    bitcoinDataDir: {
      status: preflight.bitcoinDataDir.status,
      path: preflight.bitcoinDataDir.path,
      conditionalPrompt: preflight.bitcoinDataDir.shouldPrompt
        ? {
          prompt: "Delete managed Bitcoin datadir too? [y/N]: ",
          defaultAction: "preserve",
          acceptedInputs: ["", "n", "no", "y", "yes"],
        }
        : null,
    },
    trackedProcessKinds: preflight.trackedProcessKinds,
    willDeleteOsSecrets: resetDeletesOsSecrets({
      provider,
      preflight,
    }),
    removedPaths,
  };
}
