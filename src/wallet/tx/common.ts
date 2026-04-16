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

export interface MutationSender {
  localIndex: number;
  scriptPubKeyHex: string;
  address: string;
}

export interface WalletMutationRpcClient {
  listUnspent(walletName: string, minConf?: number): Promise<RpcListUnspentEntry[]>;
  listLockUnspent(walletName: string): Promise<RpcLockedUnspent[]>;
  lockUnspent(walletName: string, unlock: boolean, outputs: RpcLockedUnspent[]): Promise<boolean>;
  walletCreateFundedPsbt(
    walletName: string,
    inputs: Array<{ txid: string; vout: number }>,
    outputs: unknown[],
    locktime: number,
    options: Record<string, unknown>,
    bip32Derivs?: boolean,
  ): Promise<RpcWalletCreateFundedPsbtResult>;
  decodePsbt(psbt: string): Promise<RpcDecodedPsbt>;
  walletProcessPsbt(
    walletName: string,
    psbt: string,
    sign?: boolean,
    sighashType?: string,
  ): Promise<RpcWalletProcessPsbtResult>;
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
  if (outpoints.length === 0) {
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

export function getDecodedInputScriptPubKeyHex(input: RpcVin): string | null {
  return input.prevout?.scriptPubKey?.hex ?? null;
}

export function getDecodedInputVout(input: RpcVin): number | null {
  const vout = (input as RpcVin & { vout?: unknown }).vout;
  return typeof vout === "number" ? vout : null;
}

export function inputMatchesOutpoint(input: RpcVin, outpoint: OutpointRecord): boolean {
  return input.txid === outpoint.txid && getDecodedInputVout(input) === outpoint.vout;
}

export function assertFixedInputPrefixMatches(
  inputs: RpcVin[],
  fixedInputs: FixedWalletInput[],
  errorCode: string,
): void {
  if (inputs.length < fixedInputs.length) {
    throw new Error(errorCode);
  }

  for (const [index, fixedInput] of fixedInputs.entries()) {
    if (!inputMatchesOutpoint(inputs[index]!, fixedInput)) {
      throw new Error(errorCode);
    }
  }
}

export function assertFundingInputsAfterFixedPrefix(options: {
  inputs: RpcVin[];
  fixedInputs: FixedWalletInput[];
  allowedFundingScriptPubKeyHex: string;
  eligibleFundingOutpointKeys: Set<string>;
  errorCode: string;
}): void {
  for (let index = options.fixedInputs.length; index < options.inputs.length; index += 1) {
    const input = options.inputs[index]!;
    const scriptPubKeyHex = getDecodedInputScriptPubKeyHex(input);
    const vout = getDecodedInputVout(input);
    if (scriptPubKeyHex !== options.allowedFundingScriptPubKeyHex || vout === null || typeof input.txid !== "string") {
      throw new Error(options.errorCode);
    }

    const key = outpointKey({
      txid: input.txid,
      vout,
    });
    if (!options.eligibleFundingOutpointKeys.has(key)) {
      throw new Error(options.errorCode);
    }
  }
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
    fixedInputs: options.fixedInputs,
    temporarilyUnlockedOutpoints: options.temporarilyUnlockedOutpoints,
    cleanupInactiveTemporaryBuilderLocks: options.cleanupInactiveTemporaryBuilderLocks,
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
  };
  validateFundedDraft(
    decoded: RpcDecodedPsbt,
    funded: RpcWalletCreateFundedPsbtResult,
    plan: TPlan,
  ): void;
  finalizeErrorCode: string;
  mempoolRejectPrefix: string;
  feeRate?: number;
  temporarilyUnlockedPolicyOutpoints?: readonly OutpointRecord[];
}): Promise<BuiltWalletMutationTransaction> {
  await reconcilePersistentPolicyLocks({
    rpc: options.rpc,
    walletName: options.walletName,
    state: options.state,
    fixedInputs: options.plan.fixedInputs,
    temporarilyUnlockedOutpoints: options.temporarilyUnlockedPolicyOutpoints,
  });
  const lockedBefore = await options.rpc.listLockUnspent(options.walletName);
  let temporaryBuilderLockedOutpoints: OutpointRecord[] = [];

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
          lockUnspents: true,
          fee_rate: options.feeRate ?? DEFAULT_WALLET_MUTATION_FEE_RATE_SAT_VB,
          replaceable: true,
          subtractFeeFromOutputs: [],
        },
      );
    const lockedAfter = await options.rpc.listLockUnspent(options.walletName);
    temporaryBuilderLockedOutpoints = diffTemporaryLockedOutpoints(lockedBefore, lockedAfter);
    const decoded = await options.rpc.decodePsbt(funded.psbt);
    options.validateFundedDraft(decoded, funded, options.plan);
    const signed = await options.rpc.walletProcessPsbt(options.walletName, funded.psbt, true, "DEFAULT");
    const finalized = await options.rpc.finalizePsbt(signed.psbt, true);

    if (!finalized.complete || finalized.hex == null) {
      throw new Error(options.finalizeErrorCode);
    }

    const decodedRaw = await options.rpc.decodeRawTransaction(finalized.hex);
    const mempoolResult = await options.rpc.testMempoolAccept([finalized.hex]);
    const accepted = mempoolResult[0];

    if (accepted == null || !accepted.allowed) {
      throw new Error(`${options.mempoolRejectPrefix}_${accepted?.["reject-reason"] ?? "unknown"}`);
    }

    if ((options.temporarilyUnlockedPolicyOutpoints?.length ?? 0) > 0) {
      await reconcilePersistentPolicyLocks({
        rpc: options.rpc,
        walletName: options.walletName,
        state: options.state,
        fixedInputs: options.plan.fixedInputs,
      });
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
    if ((options.temporarilyUnlockedPolicyOutpoints?.length ?? 0) > 0) {
      await reconcilePersistentPolicyLocks({
        rpc: options.rpc,
        walletName: options.walletName,
        state: options.state,
        fixedInputs: options.plan.fixedInputs,
      });
    }
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
  };
  validateFundedDraft(
    decoded: RpcDecodedPsbt,
    funded: RpcWalletCreateFundedPsbtResult,
    plan: TPlan,
  ): void;
  finalizeErrorCode: string;
  mempoolRejectPrefix: string;
  feeRate?: number;
  reserveCandidates: readonly OutpointRecord[];
}): Promise<BuiltWalletMutationTransaction> {
  let unlockedReserveOutpoints: OutpointRecord[] = [];
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= options.reserveCandidates.length; attempt += 1) {
    if (attempt > 0) {
      unlockedReserveOutpoints = [
        ...unlockedReserveOutpoints,
        options.reserveCandidates[attempt - 1]!,
      ];
    }

    try {
      return await buildWalletMutationTransaction({
        rpc: options.rpc,
        walletName: options.walletName,
        state: options.state,
        plan: options.plan,
        validateFundedDraft: options.validateFundedDraft,
        finalizeErrorCode: options.finalizeErrorCode,
        mempoolRejectPrefix: options.mempoolRejectPrefix,
        feeRate: options.feeRate,
        temporarilyUnlockedPolicyOutpoints: unlockedReserveOutpoints,
      });
    } catch (error) {
      lastError = error;
      if (!isInsufficientFundsError(error) || attempt === options.reserveCandidates.length) {
        throw error;
      }
    }
  }

  throw lastError;
}
