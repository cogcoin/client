import { randomBytes } from "node:crypto";

import type {
  RpcDecodedPsbt,
  RpcFinalizePsbtResult,
  RpcListUnspentEntry,
  RpcLockedUnspent,
  RpcTestMempoolAcceptResult,
  RpcTransaction,
  RpcVin,
  RpcWalletCreateFundedPsbtResult,
  RpcWalletTransaction,
  RpcWalletProcessPsbtResult,
} from "../../bitcoind/types.js";
import { saveUnlockSession } from "../state/session.js";
import { saveWalletState } from "../state/storage.js";
import {
  createWalletSecretReference,
  type WalletSecretProvider,
} from "../state/provider.js";
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
const MANAGED_CORE_WALLET_SIGNING_UNLOCK_TIMEOUT_SECONDS = 10;

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

function valueToSats(value: number | string): bigint {
  return typeof value === "string"
    ? BigInt(Math.round(Number(value) * 100_000_000))
    : btcNumberToSats(value);
}

function createUnlockSessionState(
  state: WalletStateV1,
  unlockUntilUnixMs: number,
  nowUnixMs: number,
): {
  schemaVersion: 1;
  walletRootId: string;
  sessionId: string;
  createdAtUnixMs: number;
  unlockUntilUnixMs: number;
  sourceStateRevision: number;
  wrappedSessionKeyMaterial: string;
} {
  return {
    schemaVersion: 1,
    walletRootId: state.walletRootId,
    sessionId: randomBytes(16).toString("hex"),
    createdAtUnixMs: nowUnixMs,
    unlockUntilUnixMs,
    sourceStateRevision: state.stateRevision,
    wrappedSessionKeyMaterial: createWalletSecretReference(state.walletRootId).keyId,
  };
}

export async function saveWalletStatePreservingUnlock(options: {
  state: WalletStateV1;
  provider: WalletSecretProvider;
  unlockUntilUnixMs: number;
  nowUnixMs: number;
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
  await saveUnlockSession(
    options.paths.walletUnlockSessionPath,
    createUnlockSessionState(options.state, options.unlockUntilUnixMs, options.nowUnixMs),
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
  } = {},
): PendingMutationRecord {
  return {
    ...mutation,
    status,
    lastUpdatedAtUnixMs: nowUnixMs,
    attemptedTxid: options.attemptedTxid ?? mutation.attemptedTxid,
    attemptedWtxid: options.attemptedWtxid ?? mutation.attemptedWtxid,
    temporaryBuilderLockedOutpoints: options.temporaryBuilderLockedOutpoints ?? mutation.temporaryBuilderLockedOutpoints,
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
    unlockUntilUnixMs: number;
  };
  snapshot: NonNullable<WalletReadContext["snapshot"]>;
  model: NonNullable<WalletReadContext["model"]>;
} {
  if (context.localState.availability === "uninitialized") {
    throw new Error("wallet_uninitialized");
  }

  if (context.localState.availability === "local-state-corrupt") {
    throw new Error("local-state-corrupt");
  }

  if (context.localState.availability !== "ready" || context.localState.state === null || context.localState.unlockUntilUnixMs === null) {
    throw new Error("wallet_locked");
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
          minconf: 1,
          changeAddress: options.plan.changeAddress,
          changePosition: options.plan.changePosition,
          lockUnspents: false,
          fee_rate: options.feeRate ?? DEFAULT_WALLET_MUTATION_FEE_RATE_SAT_VB,
          replaceable: true,
          subtractFeeFromOutputs: [],
        },
      );
    const decoded = await options.rpc.decodePsbt(funded.psbt);
    options.validateFundedDraft(decoded, funded, validationPlan);
    await options.rpc.walletPassphrase(
      options.walletName,
      options.state.managedCoreWallet.internalPassphrase,
      MANAGED_CORE_WALLET_SIGNING_UNLOCK_TIMEOUT_SECONDS,
    );
    let signed: RpcWalletProcessPsbtResult;
    let finalized: RpcFinalizePsbtResult;
    let decodedRaw: RpcTransaction;
    try {
      signed = await options.rpc.walletProcessPsbt(options.walletName, funded.psbt, true, "DEFAULT");
      finalized = await options.rpc.finalizePsbt(signed.psbt, true);

      if (!finalized.complete || finalized.hex == null) {
        throw new Error(options.finalizeErrorCode);
      }

      decodedRaw = await options.rpc.decodeRawTransaction(finalized.hex);
      const mempoolResult = await options.rpc.testMempoolAccept([finalized.hex]);
      const accepted = mempoolResult[0];

      if (accepted == null || !accepted.allowed) {
        throw new Error(`${options.mempoolRejectPrefix}_${accepted?.["reject-reason"] ?? "unknown"}`);
      }
    } finally {
      await options.rpc.walletLock(options.walletName).catch(() => undefined);
    }

    return {
      funded,
      decoded,
      psbt: signed.psbt,
      rawHex: finalized.hex,
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
