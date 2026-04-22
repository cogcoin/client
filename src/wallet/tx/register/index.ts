import { loadBundledGenesisParameters } from "@cogcoin/indexer";

import {
  buildWalletMutationTransactionWithReserveFallback,
  mergeFixedWalletInputs,
  updateMutationRecord,
} from "../common.js";
import {
  executeWalletMutationOperation,
  publishWalletMutation,
  resolveExistingWalletMutation,
} from "../executor.js";
import { upsertPendingMutation } from "../journal.js";
import {
  confirmRootRegistration,
  confirmSubdomainRegistration,
  findCompetingRootRegistrationTxids,
} from "./confirm.js";
import {
  createRegisterDraftMutation,
  getMutationStatusAfterAcceptance,
  reconcilePendingRegisterMutation,
  reserveLocalDomainRecord,
} from "./draft.js";
import {
  createRegisterOperationFingerprint,
  normalizeRegisterDomainName,
  resolveRegisterOperation,
  type BuiltRegisterTransaction,
  type RegisterDomainOptions,
  type RegisterMutationOperation,
  type WalletRegisterRpcClient,
} from "./intent.js";
import {
  buildRegisterPlan,
  buildRegisterTransaction,
  extractOpReturnPayloadFromScriptHex,
} from "./plan.js";
import {
  createRegisterResult,
  createRegisterReuseResult,
  type RegisterDomainResult,
} from "./result.js";
import { serializeDomainReg } from "../../cogop/index.js";

export { extractOpReturnPayloadFromScriptHex } from "./plan.js";
export type { RegisterDomainOptions } from "./intent.js";
export type { RegisterDomainResult } from "./result.js";

export async function registerDomain(options: RegisterDomainOptions): Promise<RegisterDomainResult> {
  if (!options.prompter.isInteractive && options.assumeYes !== true) {
    throw new Error("wallet_register_requires_tty");
  }

  const normalizedDomainName = normalizeRegisterDomainName(options.domainName);
  const execution = await executeWalletMutationOperation<
    RegisterMutationOperation,
    WalletRegisterRpcClient,
    null,
    BuiltRegisterTransaction,
    RegisterDomainResult
  >({
    ...options,
    controlLockPurpose: "wallet-register",
    preemptionReason: "wallet-register",
    async resolveOperation(readContext) {
      return resolveRegisterOperation({
        readContext,
        normalizedDomainName,
        fromIdentity: options.fromIdentity,
        loadGenesisParameters: options.loadGenesisParameters ?? loadBundledGenesisParameters,
      });
    },
    createIntentFingerprint(operation) {
      return createRegisterOperationFingerprint(operation);
    },
    async resolveExistingMutation({ operation, existingMutation, execution }) {
      if (existingMutation === null) {
        return { state: operation.state, replacementFixedInputs: null, result: null };
      }

      return resolveExistingWalletMutation({
        existingMutation,
        execution,
        repairRequiredErrorCode: "wallet_register_repair_required",
        reconcileExistingMutation: (mutation) => reconcilePendingRegisterMutation({
          state: operation.state,
          mutation,
          provider: execution.provider,
          nowUnixMs: execution.nowUnixMs,
          paths: execution.paths,
          rpc: execution.rpc,
          walletName: execution.walletName,
          context: execution.readContext,
          sender: operation.senderResolution.sender,
        }),
        createReuseResult: ({ mutation, resolution, fees }) => createRegisterReuseResult({
          operation,
          mutation,
          resolution,
          fees,
        }),
      });
    },
    async confirm({ operation, execution }) {
      if (operation.senderResolution.registerKind === "root") {
        const competingRootTxids = await findCompetingRootRegistrationTxids(
          execution.rpc,
          operation.normalizedDomainName,
        );
        if (competingRootTxids.length > 0 && !options.forceRace) {
          throw new Error("wallet_register_root_race_detected");
        }

        await confirmRootRegistration(
          options.prompter,
          operation.normalizedDomainName,
          operation.resolvedSummary,
          competingRootTxids.length > 0,
          options.assumeYes,
        );
        return;
      }

      await confirmSubdomainRegistration(
        options.prompter,
        operation.normalizedDomainName,
        operation.resolvedSummary,
        options.assumeYes,
      );
    },
    createDraftMutation({ operation, existingMutation, execution, intentFingerprintHex }) {
      return {
        mutation: createRegisterDraftMutation({
          domainName: operation.normalizedDomainName,
          parentDomainName: operation.senderResolution.parentDomainName,
          sender: operation.senderResolution.sender,
          registerKind: operation.senderResolution.registerKind,
          intentFingerprintHex,
          nowUnixMs: execution.nowUnixMs,
          feeSelection: execution.feeSelection,
          existing: existingMutation,
        }),
        prepared: null,
      };
    },
    async build({ operation, state, execution, replacementFixedInputs }) {
      const plan = buildRegisterPlan({
        context: execution.readContext,
        state,
        allUtxos: await execution.rpc.listUnspent(execution.walletName, 1),
        sender: operation.senderResolution.sender,
        registerKind: operation.senderResolution.registerKind,
        domainName: operation.normalizedDomainName,
        parentDomainName: operation.senderResolution.parentDomainName,
        treasuryAddress: operation.genesis.treasuryAddress,
        treasuryScriptPubKeyHex: Buffer.from(operation.genesis.treasuryScriptPubKey).toString("hex"),
        rootPriceSats: operation.rootPriceSats,
        serializeDomainReg: (domainName) => serializeDomainReg(domainName),
      });
      return buildRegisterTransaction({
        rpc: execution.rpc,
        walletName: execution.walletName,
        state,
        plan: {
          ...plan,
          fixedInputs: mergeFixedWalletInputs(plan.fixedInputs, replacementFixedInputs),
        },
        feeRateSatVb: execution.feeSelection.feeRateSatVb,
      });
    },
    publish({ operation, state, execution, built, mutation }) {
      return publishWalletMutation({
        rpc: execution.rpc,
        walletName: execution.walletName,
        snapshotHeight: execution.readContext.snapshot?.tip?.height ?? null,
        built,
        mutation,
        state,
        provider: execution.provider,
        nowUnixMs: execution.nowUnixMs,
        paths: execution.paths,
        errorPrefix: "wallet_register",
        async afterAccepted({ state: acceptedState, broadcastingMutation, built, nowUnixMs }) {
          const finalStatus = getMutationStatusAfterAcceptance({
            snapshot: execution.readContext.snapshot,
            domainName: operation.normalizedDomainName,
            senderScriptPubKeyHex: operation.senderResolution.sender.scriptPubKeyHex,
          });
          const finalMutation = updateMutationRecord(broadcastingMutation, finalStatus, nowUnixMs, {
            attemptedTxid: built.txid,
            attemptedWtxid: built.wtxid,
            temporaryBuilderLockedOutpoints: [],
          });
          return {
            state: reserveLocalDomainRecord({
              state: upsertPendingMutation(acceptedState, finalMutation),
              domainName: operation.normalizedDomainName,
              sender: operation.senderResolution.sender,
              nowUnixMs,
            }),
            mutation: finalMutation,
            status: finalStatus,
          };
        },
      });
    },
    createResult({ operation, mutation, built, status, reusedExisting, fees }) {
      return createRegisterResult({
        operation,
        mutation,
        builtTxid: built?.txid ?? null,
        status: status as RegisterDomainResult["status"],
        reusedExisting,
        fees,
      });
    },
  });

  return execution.result;
}
