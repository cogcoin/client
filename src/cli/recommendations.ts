import type { WalletReadContext } from "../wallet/read/index.js";

export function getRepairRecommendation(context: WalletReadContext): string | null {
  if (
    context.localState.clientPasswordReadiness === "setup-required"
    || context.localState.clientPasswordReadiness === "migration-required"
  ) {
    return "Run `cogcoin init` to configure the client password and migrate local wallet secrets.";
  }

  if (context.localState.unlockRequired) {
    return null;
  }

  if (context.localState.availability === "uninitialized") {
    return "Run `cogcoin init` to create or restore a wallet.";
  }

  if (context.localState.availability === "local-state-corrupt") {
    return "Run `cogcoin repair` to recover local wallet state.";
  }

  if (
    context.bitcoind.health === "service-version-mismatch"
    || context.bitcoind.health === "wallet-root-mismatch"
    || context.bitcoind.health === "runtime-mismatch"
    || context.bitcoind.health === "replica-missing"
    || context.bitcoind.health === "replica-mismatch"
    || context.bitcoind.health === "failed"
  ) {
    return "Run `cogcoin repair` to recover the managed bitcoind service and Core wallet replica.";
  }

  if (
    context.indexer.health === "failed"
    || context.indexer.health === "schema-mismatch"
    || context.indexer.health === "service-version-mismatch"
    || context.indexer.health === "wallet-root-mismatch"
  ) {
    return "Run `cogcoin repair` to recover the managed indexer daemon and local indexer artifacts.";
  }

  if (
    context.localState.state?.miningState.state === "repair-required"
    || (context.localState.state?.pendingMutations ?? []).some((mutation) => mutation.status === "repair-required")
  ) {
    return "Run `cogcoin repair` before relying on local wallet state.";
  }

  return null;
}

export function getClientUnlockRecommendation(context: WalletReadContext): string | null {
  if (context.localState.unlockRequired) {
    return "Rerun this command in an interactive terminal so Cogcoin can prompt for the client password.";
  }

  return null;
}

export function getMutationRecommendation(context: WalletReadContext): string | null {
  const pendingMutations = context.localState.state?.pendingMutations ?? [];
  const unresolved = pendingMutations.find((mutation) =>
    mutation.status === "broadcast-unknown" || mutation.status === "repair-required"
  );

  if (unresolved === undefined) {
    return null;
  }

  if (unresolved.status === "repair-required") {
    return "Run `cogcoin repair` before starting another mutation.";
  }

  if (unresolved.kind === "register") {
    return `Rerun \`cogcoin register ${unresolved.domainName}\` to reconcile the pending registration, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "anchor") {
    return `Rerun \`cogcoin anchor ${unresolved.domainName}\` to reconcile the pending anchor, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "transfer") {
    return `Rerun \`cogcoin transfer ${unresolved.domainName}\` with the same target to reconcile the pending transfer, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "sell") {
    const command = unresolved.priceCogtoshi === 0n ? "unsell" : "sell";
    return `Rerun \`cogcoin ${command} ${unresolved.domainName}\` to reconcile the pending listing change, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "buy") {
    return `Rerun \`cogcoin buy ${unresolved.domainName}\` to reconcile the pending purchase, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "endpoint") {
    return unresolved.endpointValueHex === ""
      ? `Rerun \`cogcoin domain endpoint clear ${unresolved.domainName}\` to reconcile the pending endpoint clear, or run \`cogcoin repair\` if it remains unresolved.`
      : `Rerun \`cogcoin domain endpoint set ${unresolved.domainName} ...\` to reconcile the pending endpoint update, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "delegate") {
    return unresolved.recipientScriptPubKeyHex === null
      ? `Rerun \`cogcoin domain delegate clear ${unresolved.domainName}\` to reconcile the pending delegate clear, or run \`cogcoin repair\` if it remains unresolved.`
      : `Rerun \`cogcoin domain delegate set ${unresolved.domainName} ...\` to reconcile the pending delegate update, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "miner") {
    return unresolved.recipientScriptPubKeyHex === null
      ? `Rerun \`cogcoin domain miner clear ${unresolved.domainName}\` to reconcile the pending miner clear, or run \`cogcoin repair\` if it remains unresolved.`
      : `Rerun \`cogcoin domain miner set ${unresolved.domainName} ...\` to reconcile the pending miner update, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "canonical") {
    return `Rerun \`cogcoin domain canonical ${unresolved.domainName}\` to reconcile the pending canonical update, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "field-create") {
    return `Rerun \`cogcoin field create ${unresolved.domainName} ${unresolved.fieldName} ...\` to reconcile the pending field creation, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "field-set") {
    return `Rerun \`cogcoin field set ${unresolved.domainName} ${unresolved.fieldName} ...\` to reconcile the pending field update, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "field-clear") {
    return `Rerun \`cogcoin field clear ${unresolved.domainName} ${unresolved.fieldName}\` to reconcile the pending field clear, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "rep-give") {
    return `Rerun \`cogcoin rep give ${unresolved.domainName} ${unresolved.recipientDomainName ?? "..."} ...\` to reconcile the pending reputation support, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "rep-revoke") {
    return `Rerun \`cogcoin rep revoke ${unresolved.domainName} ${unresolved.recipientDomainName ?? "..."} ...\` to reconcile the pending reputation revoke, or run \`cogcoin repair\` if it remains unresolved.`;
  }

  if (unresolved.kind === "send") {
    return "Rerun the same `cogcoin send ...` command to reconcile the pending transfer, or run `cogcoin repair` if it remains unresolved.";
  }

  if (unresolved.kind === "lock") {
    return "Rerun the same `cogcoin cog lock ...` command to reconcile the pending lock, or run `cogcoin repair` if it remains unresolved.";
  }

  return unresolved.preimageHex === "0000000000000000000000000000000000000000000000000000000000000000"
    ? "Rerun the same `cogcoin reclaim ...` command to reconcile the pending reclaim, or run `cogcoin repair` if it remains unresolved."
    : "Rerun the same `cogcoin claim ...` command to reconcile the pending claim, or run `cogcoin repair` if it remains unresolved.";
}
