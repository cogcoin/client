import type { WalletReadContext } from "../read/index.js";
import type {
  WalletMutationReadyReadState,
} from "./types.js";

export function assertWalletMutationContextReady(
  context: WalletReadContext,
  errorPrefix: string,
): asserts context is WalletReadContext
  & WalletMutationReadyReadState
  & {
    snapshot: NonNullable<WalletReadContext["snapshot"]>;
    model: NonNullable<WalletReadContext["model"]>;
  } {
  if (context.localState.availability === "uninitialized") {
    throw new Error("wallet_uninitialized");
  }

  if (context.localState.clientPasswordReadiness === "setup-required") {
    throw new Error("wallet_client_password_setup_required");
  }

  if (context.localState.clientPasswordReadiness === "migration-required") {
    throw new Error("wallet_client_password_migration_required");
  }

  if (context.localState.unlockRequired) {
    throw new Error("wallet_client_password_locked");
  }

  if (context.localState.availability === "local-state-corrupt") {
    throw new Error("local-state-corrupt");
  }

  if (context.localState.availability !== "ready" || context.localState.state === null) {
    throw new Error("wallet_secret_provider_unavailable");
  }

  if (context.bitcoind.health !== "ready") {
    throw new Error(`${errorPrefix}_bitcoind_${context.bitcoind.health.replaceAll("-", "_")}`);
  }

  if (context.nodeHealth !== "synced") {
    throw new Error(`${errorPrefix}_node_${context.nodeHealth.replaceAll("-", "_")}`);
  }

  if (context.indexer.health !== "synced" || context.snapshot === null || context.model === null) {
    throw new Error(`${errorPrefix}_indexer_${context.indexer.health.replaceAll("-", "_")}`);
  }

  if (context.nodeStatus?.walletReplica?.proofStatus !== "ready") {
    throw new Error(`${errorPrefix}_core_replica_not_ready`);
  }
}

export function assertWalletBitcoinTransferContextReady(
  context: WalletReadContext,
  errorPrefix: string,
): asserts context is WalletReadContext & WalletMutationReadyReadState {
  if (context.localState.availability === "uninitialized") {
    throw new Error("wallet_uninitialized");
  }

  if (context.localState.clientPasswordReadiness === "setup-required") {
    throw new Error("wallet_client_password_setup_required");
  }

  if (context.localState.clientPasswordReadiness === "migration-required") {
    throw new Error("wallet_client_password_migration_required");
  }

  if (context.localState.unlockRequired) {
    throw new Error("wallet_client_password_locked");
  }

  if (context.localState.availability === "local-state-corrupt") {
    throw new Error("local-state-corrupt");
  }

  if (context.localState.availability !== "ready" || context.localState.state === null) {
    throw new Error("wallet_secret_provider_unavailable");
  }

  if (context.bitcoind.health !== "ready") {
    throw new Error(`${errorPrefix}_bitcoind_${context.bitcoind.health.replaceAll("-", "_")}`);
  }

  if (context.nodeHealth !== "synced") {
    throw new Error(`${errorPrefix}_node_${context.nodeHealth.replaceAll("-", "_")}`);
  }

  if (context.nodeStatus?.walletReplica?.proofStatus !== "ready") {
    throw new Error(`${errorPrefix}_core_replica_not_ready`);
  }
}
