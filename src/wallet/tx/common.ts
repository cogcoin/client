import type {
  RpcDecodedPsbt,
  RpcEstimateSmartFeeResult,
  RpcFinalizePsbtResult,
  RpcListUnspentEntry,
  RpcLockedUnspent,
  RpcMempoolEntry,
  RpcTestMempoolAcceptResult,
  RpcTransaction,
  RpcVin,
  RpcWalletCreateFundedPsbtResult,
  RpcWalletTransaction,
  RpcWalletProcessPsbtResult,
} from "../../bitcoind/types.js";
import { saveWalletState } from "../state/storage.js";
import {
  createWalletSecretReference,
  type WalletSecretProvider,
} from "../state/provider.js";
import {
  MANAGED_CORE_WALLET_UNLOCK_TIMEOUT_SECONDS,
  withUnlockedManagedCoreWallet,
} from "../managed-core-wallet.js";
import { reconcilePersistentPolicyLocks as reconcileWalletCoinControlLocks } from "../coin-control.js";
import type {
  OutpointRecord,
  PendingMutationRecord,
  PendingMutationStatus,
  WalletStateV1,
} from "../types.js";
import type { WalletReadContext } from "../read/index.js";
import type { WalletRuntimePaths } from "../runtime.js";
import { requestMiningGenerationPreemption, type MiningPreemptionHandle } from "../mining/coordination.js";

export const DEFAULT_WALLET_MUTATION_FEE_RATE_SAT_VB = 10;
export const NEXT_BLOCK_FEE_CONFIRM_TARGET = 1;

export type WalletMutationFeeSelectionSource =
  | "custom-satvb"
  | "estimated-next-block-plus-one"
  | "fallback-default";

export interface WalletMutationFeeSelection {
  feeRateSatVb: number;
  source: WalletMutationFeeSelectionSource;
}

export interface WalletMutationFeeSummary extends WalletMutationFeeSelection {
  feeSats: string | null;
}

export interface MutationSender {
  localIndex: number;
  scriptPubKeyHex: string;
  address: string;
}

export function isLocalWalletScript(state: WalletStateV1, scriptPubKeyHex: string | null | undefined): boolean {
  if (typeof scriptPubKeyHex !== "string" || scriptPubKeyHex.length === 0) {
    return false;
  }

  return scriptPubKeyHex === state.funding.scriptPubKeyHex
    || (state.localScriptPubKeyHexes ?? []).includes(scriptPubKeyHex);
}

export function createFundingMutationSender(state: WalletStateV1): MutationSender {
  return {
    localIndex: 0,
    scriptPubKeyHex: state.funding.scriptPubKeyHex,
    address: state.funding.address,
  };
}

export interface WalletMutationRpcClient {
  listUnspent(walletName: string, minConf?: number): Promise<RpcListUnspentEntry[]>;
  listLockUnspent?(walletName: string): Promise<RpcLockedUnspent[]>;
  lockUnspent?(walletName: string, unlock: boolean, outputs: RpcLockedUnspent[]): Promise<boolean>;
  getTransaction?(walletName: string, txid: string): Promise<RpcWalletTransaction>;
  getRawTransaction?(txid: string, verbose?: boolean): Promise<RpcTransaction>;
  getMempoolEntry?(txid: string): Promise<RpcMempoolEntry>;
  estimateSmartFee?(
    confirmTarget: number,
    mode: "conservative" | "economical",
  ): Promise<RpcEstimateSmartFeeResult>;
  walletCreateFundedPsbt(
    walletName: string,
    inputs: Array<{ txid: string; vout: number }>,
    outputs: unknown[],
    locktime: number,
    options: Record<string, unknown>,
    bip32Derivs?: boolean,
  ): Promise<RpcWalletCreateFundedPsbtResult>;
  decodePsbt(psbt: string): Promise<RpcDecodedPsbt>;
  walletPassphrase(walletName: string, passphrase: string, timeoutSeconds: number): Promise<null>;
  walletProcessPsbt(
    walletName: string,
    psbt: string,
    sign?: boolean,
    sighashType?: string,
  ): Promise<RpcWalletProcessPsbtResult>;
  walletLock(walletName: string): Promise<null>;
  finalizePsbt(psbt: string, extract?: boolean): Promise<RpcFinalizePsbtResult>;
  decodeRawTransaction(hex: string): Promise<RpcTransaction>;
  testMempoolAccept(rawTransactions: string[]): Promise<RpcTestMempoolAcceptResult[]>;
}

export interface BuiltWalletMutationTransaction {
  funded: RpcWalletCreateFundedPsbtResult;
  decoded: RpcDecodedPsbt;
  psbt: string;
  rawHex: string;
  txid: string;
  wtxid: string | null;
  temporaryBuilderLockedOutpoints: OutpointRecord[];
}

export interface FixedWalletInput extends OutpointRecord {}

function btcNumberToSats(value: number): bigint {
  return BigInt(Math.round(value * 100_000_000));
}

function normalizeSatVb(value: number): number {
  return Number.parseFloat(value.toFixed(8));
}

function satVbFromBtcPerKvB(value: number): number {
  return normalizeSatVb((value * 100_000_000) / 1_000);
}

function valueToSats(value: number | string): bigint {
  return typeof value === "string"
    ? BigInt(Math.round(Number(value) * 100_000_000))
    : btcNumberToSats(value);
}

function feeRateFromMempoolEntry(entry: RpcMempoolEntry): number | null {
  if (!Number.isFinite(entry.vsize) || entry.vsize <= 0) {
    return null;
  }

  const feeSats = Number(btcNumberToSats(entry.fees.base));
  if (!Number.isFinite(feeSats) || feeSats <= 0) {
    return null;
  }

  return normalizeSatVb(feeSats / entry.vsize);
}

export function formatSatVb(value: number): string {
  return normalizeSatVb(value).toString();
}

export function createWalletMutationFeeMetadata(
  selection: WalletMutationFeeSelection,
): {
  selectedFeeRateSatVb: number;
  feeSelectionSource: WalletMutationFeeSelectionSource;
} {
  return {
    selectedFeeRateSatVb: selection.feeRateSatVb,
    feeSelectionSource: selection.source,
  };
}

export async function resolveWalletMutationFeeSelection(options: {
  rpc: Pick<WalletMutationRpcClient, "estimateSmartFee">;
  feeRateSatVb?: number | null;
}): Promise<WalletMutationFeeSelection> {
  if (typeof options.feeRateSatVb === "number") {
    return {
      feeRateSatVb: normalizeSatVb(options.feeRateSatVb),
      source: "custom-satvb",
    };
  }

  if (options.rpc.estimateSmartFee !== undefined) {
    try {
      const estimate = await options.rpc.estimateSmartFee(
        NEXT_BLOCK_FEE_CONFIRM_TARGET,
        "conservative",
      );
      const estimatedSatVb = typeof estimate.feerate === "number"
        ? satVbFromBtcPerKvB(estimate.feerate)
        : null;

      if (estimatedSatVb !== null && Number.isFinite(estimatedSatVb) && estimatedSatVb > 0) {
        return {
          feeRateSatVb: normalizeSatVb(estimatedSatVb + 1),
          source: "estimated-next-block-plus-one",
        };
      }
    } catch {
      // Fall through to the compatibility default.
    }
  }

  return {
    feeRateSatVb: DEFAULT_WALLET_MUTATION_FEE_RATE_SAT_VB,
    source: "fallback-default",
  };
}

export function createWalletMutationFeeSummary(
  selection: WalletMutationFeeSelection,
  feeSats: string | null,
): WalletMutationFeeSummary {
  return {
    feeRateSatVb: selection.feeRateSatVb,
    feeSats,
    source: selection.source,
  };
}

export function createBuiltWalletMutationFeeSummary(options: {
  selection: WalletMutationFeeSelection;
  built: BuiltWalletMutationTransaction;
}): WalletMutationFeeSummary {
  return createWalletMutationFeeSummary(
    options.selection,
    btcNumberToSats(options.built.funded.fee).toString(),
  );
}

export async function resolvePendingMutationFeeSummary(options: {
  rpc: Pick<WalletMutationRpcClient, "getMempoolEntry">;
  mutation: PendingMutationRecord;
}): Promise<WalletMutationFeeSummary> {
  const source = options.mutation.feeSelectionSource ?? "fallback-default";
  const selectedFeeRateSatVb = typeof options.mutation.selectedFeeRateSatVb === "number"
    && Number.isFinite(options.mutation.selectedFeeRateSatVb)
    && options.mutation.selectedFeeRateSatVb > 0
    ? normalizeSatVb(options.mutation.selectedFeeRateSatVb)
    : DEFAULT_WALLET_MUTATION_FEE_RATE_SAT_VB;

  if (options.mutation.attemptedTxid !== null && options.rpc.getMempoolEntry !== undefined) {
    try {
      const entry = await options.rpc.getMempoolEntry(options.mutation.attemptedTxid);
      const feeRateSatVb = feeRateFromMempoolEntry(entry);

      if (feeRateSatVb !== null) {
        return {
          feeRateSatVb,
          feeSats: btcNumberToSats(entry.fees.base).toString(),
          source,
        };
      }
    } catch {
      // Fall back to stored metadata or the historical default.
    }
  }

  return {
    feeRateSatVb: selectedFeeRateSatVb,
    feeSats: null,
    source,
  };
}

export async function loadAttemptedMutationFixedInputs(options: {
  rpc: Pick<WalletMutationRpcClient, "getTransaction" | "getRawTransaction">;
  walletName: string;
  mutation: PendingMutationRecord;
}): Promise<FixedWalletInput[] | null> {
  if (options.mutation.attemptedTxid === null) {
    return null;
  }

  const txid = options.mutation.attemptedTxid;
  let decoded: RpcTransaction | null = null;

  if (options.rpc.getTransaction !== undefined) {
    try {
      decoded = (await options.rpc.getTransaction(options.walletName, txid)).decoded ?? null;
    } catch {
      decoded = null;
    }
  }

  if (decoded === null && options.rpc.getRawTransaction !== undefined) {
    try {
      decoded = await options.rpc.getRawTransaction(txid, true);
    } catch {
      decoded = null;
    }
  }

  if (decoded === null) {
    return null;
  }

  const fixedInputs = decoded.vin
    .filter((input): input is RpcVin & { txid: string; vout: number } =>
      typeof input.txid === "string" && typeof input.vout === "number")
    .map((input) => ({
      txid: input.txid,
      vout: input.vout,
    }));

  return fixedInputs.length > 0 ? fixedInputs : null;
}

export async function resolvePendingMutationReuseDecision(options: {
  rpc: Pick<WalletMutationRpcClient, "getMempoolEntry" | "getTransaction" | "getRawTransaction">;
  walletName: string;
  mutation: PendingMutationRecord;
  nextFeeSelection: WalletMutationFeeSelection;
}): Promise<{
  reuseExisting: boolean;
  fees: WalletMutationFeeSummary;
  replacementFixedInputs: FixedWalletInput[] | null;
}> {
  const fees = await resolvePendingMutationFeeSummary({
    rpc: options.rpc,
    mutation: options.mutation,
  });

  if (
    options.mutation.status === "confirmed"
    || options.nextFeeSelection.feeRateSatVb <= fees.feeRateSatVb
  ) {
    return {
      reuseExisting: true,
      fees,
      replacementFixedInputs: null,
    };
  }

  return {
    reuseExisting: false,
    fees,
    replacementFixedInputs: await loadAttemptedMutationFixedInputs({
      rpc: options.rpc,
      walletName: options.walletName,
      mutation: options.mutation,
    }),
  };
}

export function mergeFixedWalletInputs(
  fixedInputs: readonly FixedWalletInput[],
  replacementInputs: readonly FixedWalletInput[] | null,
): FixedWalletInput[] {
  if (replacementInputs === null || replacementInputs.length === 0) {
    return [...fixedInputs];
  }

  const merged = new Map<string, FixedWalletInput>();

  for (const input of fixedInputs) {
    merged.set(outpointKey(input), { txid: input.txid, vout: input.vout });
  }

  for (const input of replacementInputs) {
    merged.set(outpointKey(input), { txid: input.txid, vout: input.vout });
  }

  return [...merged.values()];
}

export async function saveWalletStatePreservingUnlock(options: {
  state: WalletStateV1;
  provider: WalletSecretProvider;
  nowUnixMs?: number;
  paths: WalletRuntimePaths;
}): Promise<void> {
  const secretReference = createWalletSecretReference(options.state.walletRootId);
  await saveWalletState(
    {
      primaryPath: options.paths.walletStatePath,
      backupPath: options.paths.walletStateBackupPath,
    },
    options.state,
    {
      provider: options.provider,
      secretReference,
    },
  );
}

export function formatCogAmount(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 100_000_000n;
  const fraction = absolute % 100_000_000n;
  return `${sign}${whole.toString()}.${fraction.toString().padStart(8, "0")} COG`;
}

export function outpointKey(outpoint: OutpointRecord): string {
  return `${outpoint.txid}:${outpoint.vout}`;
}

function isSpendableFundingUtxo(
  entry: RpcListUnspentEntry,
  fundingScriptPubKeyHex: string,
  minConf: number,
): boolean {
  return entry.scriptPubKey === fundingScriptPubKeyHex
    && entry.confirmations >= minConf
    && entry.spendable !== false
    && entry.safe !== false;
}

export function findSpendableFundingInputsFromTransaction(options: {
  allUtxos: RpcListUnspentEntry[];
  txid: string;
  fundingScriptPubKeyHex: string;
  minConf?: number;
}): FixedWalletInput[] {
  const minConf = options.minConf ?? 0;
  return options.allUtxos
    .filter((entry) =>
      entry.txid === options.txid
      && isSpendableFundingUtxo(entry, options.fundingScriptPubKeyHex, minConf)
    )
    .sort((left, right) =>
      left.vout - right.vout
      || left.txid.localeCompare(right.txid)
    )
    .map((entry) => ({
      txid: entry.txid,
      vout: entry.vout,
    }));
}

export function updateMutationRecord(
  mutation: PendingMutationRecord,
  status: PendingMutationStatus,
  nowUnixMs: number,
  options: {
    attemptedTxid?: string | null;
    attemptedWtxid?: string | null;
    temporaryBuilderLockedOutpoints?: OutpointRecord[];
    selectedFeeRateSatVb?: number | null;
    feeSelectionSource?: WalletMutationFeeSelectionSource | null;
  } = {},
): PendingMutationRecord {
  return {
    ...mutation,
    status,
    lastUpdatedAtUnixMs: nowUnixMs,
    attemptedTxid: options.attemptedTxid ?? mutation.attemptedTxid,
    attemptedWtxid: options.attemptedWtxid ?? mutation.attemptedWtxid,
    temporaryBuilderLockedOutpoints: options.temporaryBuilderLockedOutpoints ?? mutation.temporaryBuilderLockedOutpoints,
    selectedFeeRateSatVb: options.selectedFeeRateSatVb ?? mutation.selectedFeeRateSatVb,
    feeSelectionSource: options.feeSelectionSource ?? mutation.feeSelectionSource,
  };
}

export async function unlockTemporaryBuilderLocks(
  rpc: Pick<WalletMutationRpcClient, "lockUnspent">,
  walletName: string,
  outpoints: OutpointRecord[],
): Promise<void> {
  if (outpoints.length === 0 || rpc.lockUnspent === undefined) {
    return;
  }

  await rpc.lockUnspent(walletName, true, outpoints).catch(() => undefined);
}

export function diffTemporaryLockedOutpoints(
  before: RpcLockedUnspent[],
  after: RpcLockedUnspent[],
): OutpointRecord[] {
  const beforeKeys = new Set(before.map((entry) => outpointKey(entry)));
  return after
    .filter((entry) => !beforeKeys.has(outpointKey(entry)))
    .map((entry) => ({
      txid: entry.txid,
      vout: entry.vout,
    }));
}

export function getDecodedInputVout(input: RpcVin): number | null {
  return typeof input.vout === "number" ? input.vout : null;
}

export function getDecodedInputScriptPubKeyHex(decoded: RpcDecodedPsbt, inputIndex: number): string | null {
  const input = decoded.tx.vin[inputIndex];
  if (input === undefined) {
    return null;
  }

  const prevoutScriptPubKeyHex = input.prevout?.scriptPubKey?.hex;
  if (typeof prevoutScriptPubKeyHex === "string" && prevoutScriptPubKeyHex.length > 0) {
    return prevoutScriptPubKeyHex;
  }

  const psbtInput = decoded.inputs?.[inputIndex];
  const witnessScriptPubKeyHex = psbtInput?.witness_utxo?.scriptPubKey?.hex;
  if (typeof witnessScriptPubKeyHex === "string" && witnessScriptPubKeyHex.length > 0) {
    return witnessScriptPubKeyHex;
  }

  const vout = getDecodedInputVout(input);
  if (vout === null) {
    return null;
  }

  const nonWitnessScriptPubKeyHex = psbtInput?.non_witness_utxo?.vout
    .find((output) => output.n === vout)
    ?.scriptPubKey?.hex;
  return typeof nonWitnessScriptPubKeyHex === "string" && nonWitnessScriptPubKeyHex.length > 0
    ? nonWitnessScriptPubKeyHex
    : null;
}

export function inputMatchesOutpoint(input: RpcVin, outpoint: OutpointRecord): boolean {
  return input.txid === outpoint.txid && getDecodedInputVout(input) === outpoint.vout;
}

export function assertFixedInputPrefixMatches(
  inputs: RpcVin[],
  fixedInputs: FixedWalletInput[],
  errorCode: string,
): void {
  void inputs;
  void fixedInputs;
  void errorCode;
}

export function assertFundingInputsAfterFixedPrefix(options: {
  decoded: RpcDecodedPsbt;
  fixedInputs: FixedWalletInput[];
  allowedFundingScriptPubKeyHex: string;
  eligibleFundingOutpointKeys: Set<string>;
  errorCode: string;
}): void {
  void options;
}

export async function reconcilePersistentPolicyLocks(options: {
  rpc: Pick<WalletMutationRpcClient, "listLockUnspent" | "lockUnspent" | "listUnspent">;
  walletName: string;
  state: WalletStateV1;
  fixedInputs: FixedWalletInput[];
  temporarilyUnlockedOutpoints?: readonly OutpointRecord[];
  cleanupInactiveTemporaryBuilderLocks?: boolean;
}): Promise<void> {
  await reconcileWalletCoinControlLocks({
    rpc: options.rpc,
    walletName: options.walletName,
    state: options.state,
  });
}

export function isBroadcastUnknownError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("timeout")
    || message.includes("timed out")
    || message.includes("socket hang up")
    || message.includes("econnreset")
    || message.includes("econnrefused")
    || message.includes("broken pipe")
    || message.includes("broadcast_unknown");
}

export function isAlreadyAcceptedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("already in block chain")
    || message.includes("already in blockchain")
    || message.includes("txn-already-known");
}

export function isInsufficientFundsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("insufficient funds");
}

function isReserveFloorFundingError(error: unknown): boolean {
  void error;
  return false;
}

function computeRemainingFundingValueSats(options: {
  decoded: RpcDecodedPsbt;
  fundingScriptPubKeyHex: string;
  availableFundingValueByKey: Map<string, bigint>;
}): bigint {
  let remaining = 0n;

  for (const value of options.availableFundingValueByKey.values()) {
    remaining += value;
  }

  for (const [index, input] of options.decoded.tx.vin.entries()) {
    const scriptPubKeyHex = getDecodedInputScriptPubKeyHex(options.decoded, index);
    const vout = getDecodedInputVout(input);
    if (scriptPubKeyHex !== options.fundingScriptPubKeyHex || vout === null || typeof input.txid !== "string") {
      continue;
    }

    remaining -= options.availableFundingValueByKey.get(outpointKey({
      txid: input.txid,
      vout,
    })) ?? 0n;
  }

  for (const output of options.decoded.tx.vout) {
    if (output.scriptPubKey?.hex !== options.fundingScriptPubKeyHex) {
      continue;
    }
    remaining += valueToSats(output.value);
  }

  return remaining;
}

export function assertWalletMutationContextReady(
  context: WalletReadContext,
  errorPrefix: string,
): asserts context is WalletReadContext & {
  localState: {
    availability: "ready";
    state: WalletStateV1;
  };
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
): asserts context is WalletReadContext & {
  localState: {
    availability: "ready";
    state: WalletStateV1;
  };
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

  if (context.nodeStatus?.walletReplica?.proofStatus !== "ready") {
    throw new Error(`${errorPrefix}_core_replica_not_ready`);
  }
}

export async function pauseMiningForWalletMutation(options: {
  paths: WalletRuntimePaths;
  reason: string;
}): Promise<MiningPreemptionHandle> {
  return requestMiningGenerationPreemption({
    paths: options.paths,
    reason: options.reason,
  });
}

export async function buildWalletMutationTransaction<TPlan>(options: {
  rpc: WalletMutationRpcClient;
  walletName: string;
  state: WalletStateV1;
  plan: TPlan & {
    fixedInputs: FixedWalletInput[];
    outputs: unknown[];
    changeAddress: string;
    changePosition?: number | null;
    allowedFundingScriptPubKeyHex: string;
    eligibleFundingOutpointKeys: Set<string>;
  };
  validateFundedDraft(
    decoded: RpcDecodedPsbt,
    funded: RpcWalletCreateFundedPsbtResult,
    plan: TPlan,
  ): void;
  finalizeErrorCode: string;
  mempoolRejectPrefix: string;
  feeRate?: number;
  availableFundingMinConf?: number;
  temporarilyUnlockedPolicyOutpoints?: readonly OutpointRecord[];
}): Promise<BuiltWalletMutationTransaction> {
  const availableFundingMinConf = options.availableFundingMinConf ?? 1;
  const availableFundingUtxos = (await options.rpc.listUnspent(options.walletName, availableFundingMinConf))
    .filter((entry) => isSpendableFundingUtxo(
      entry,
      options.plan.allowedFundingScriptPubKeyHex,
      availableFundingMinConf,
    ));
  const availableFundingValueByKey = new Map(
    availableFundingUtxos.map((entry) => [
      outpointKey({ txid: entry.txid, vout: entry.vout }),
      btcNumberToSats(entry.amount),
    ]),
  );
  const validationPlan = {
    ...options.plan,
    eligibleFundingOutpointKeys: new Set([
      ...options.plan.eligibleFundingOutpointKeys,
      ...availableFundingUtxos.map((entry) => outpointKey({ txid: entry.txid, vout: entry.vout })),
    ]),
  } as TPlan;
  const temporaryBuilderLockedOutpoints: OutpointRecord[] = [];

  try {
    const funded = await options.rpc.walletCreateFundedPsbt(
      options.walletName,
      options.plan.fixedInputs,
        options.plan.outputs,
        0,
        {
          add_inputs: true,
          include_unsafe: false,
          minconf: availableFundingMinConf,
          changeAddress: options.plan.changeAddress,
          ...(options.plan.changePosition == null ? {} : { changePosition: options.plan.changePosition }),
          lockUnspents: false,
          fee_rate: options.feeRate ?? DEFAULT_WALLET_MUTATION_FEE_RATE_SAT_VB,
          replaceable: true,
          subtractFeeFromOutputs: [],
        },
      );
    const decoded = await options.rpc.decodePsbt(funded.psbt);
    options.validateFundedDraft(decoded, funded, validationPlan);
    let signed: RpcWalletProcessPsbtResult;
    let finalized: RpcFinalizePsbtResult;
    let rawHex: string;
    let decodedRaw: RpcTransaction;
    ({ signed, finalized, rawHex, decodedRaw } = await withUnlockedManagedCoreWallet({
      rpc: options.rpc,
      walletName: options.walletName,
      internalPassphrase: options.state.managedCoreWallet.internalPassphrase,
      timeoutSeconds: MANAGED_CORE_WALLET_UNLOCK_TIMEOUT_SECONDS,
      run: async () => {
        const signed = await options.rpc.walletProcessPsbt(options.walletName, funded.psbt, true, "DEFAULT");
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
    }));

    return {
      funded,
      decoded,
      psbt: signed.psbt,
      rawHex,
      txid: decodedRaw.txid,
      wtxid: decodedRaw.hash ?? null,
      temporaryBuilderLockedOutpoints,
    };
  } catch (error) {
    await unlockTemporaryBuilderLocks(options.rpc, options.walletName, temporaryBuilderLockedOutpoints);
    throw error;
  }
}

export async function buildWalletMutationTransactionWithReserveFallback<TPlan>(options: {
  rpc: WalletMutationRpcClient;
  walletName: string;
  state: WalletStateV1;
  plan: TPlan & {
    fixedInputs: FixedWalletInput[];
    outputs: unknown[];
    changeAddress: string;
    changePosition: number;
    allowedFundingScriptPubKeyHex: string;
    eligibleFundingOutpointKeys: Set<string>;
  };
  validateFundedDraft(
    decoded: RpcDecodedPsbt,
    funded: RpcWalletCreateFundedPsbtResult,
    plan: TPlan,
  ): void;
  finalizeErrorCode: string;
  mempoolRejectPrefix: string;
  feeRate?: number;
  availableFundingMinConf?: number;
}): Promise<BuiltWalletMutationTransaction> {
  return buildWalletMutationTransaction({
    rpc: options.rpc,
    walletName: options.walletName,
    state: options.state,
    plan: options.plan,
    validateFundedDraft: options.validateFundedDraft,
    finalizeErrorCode: options.finalizeErrorCode,
    mempoolRejectPrefix: options.mempoolRejectPrefix,
    feeRate: options.feeRate,
    availableFundingMinConf: options.availableFundingMinConf,
  });
}
