import { randomBytes } from "node:crypto";

import {
  assaySentences,
  deriveBlendSeed,
  displayToInternalBlockhash,
  getWords,
  settleBlock,
} from "@cogcoin/scoring";
import { lookupDomainById } from "@cogcoin/indexer/queries";
import { probeIndexerDaemon } from "../../bitcoind/indexer-daemon.js";
import { loadClientConfig } from "./config.js";
import {
  isMiningGenerationAbortRequested,
  markMiningGenerationActive,
  markMiningGenerationInactive,
} from "./coordination.js";
import { resolveReadContextCoreTip } from "./engine-types.js";
import type {
  MiningCandidate,
  MiningCandidateAuthorizationRole,
  MiningCandidateProvenance,
  MiningRpcClient,
  ReadyMiningReadContext,
} from "./engine-types.js";
import type { WalletRuntimePaths } from "../runtime.js";
import type { WalletSecretProvider } from "../state/provider.js";
import type { WalletReadContext } from "../read/index.js";
import type { WalletStateV1 } from "../types.js";
import type { MiningRuntimeStatusV1 } from "./types.js";
import { createMiningSentenceRequestLimits } from "./sentence-protocol.js";
import { generateMiningSentences, type MiningSentenceGenerationRequest } from "./sentences.js";
import { createMiningStopRequestedError } from "./stop.js";
import { resolveMineableWalletDomain } from "../read/index.js";

const BEST_BLOCK_POLL_INTERVAL_MS = 500;

export interface MiningEligibleAnchoredRoot {
  domainId: number;
  domainName: string;
  localIndex: number;
  sender: MiningCandidate["sender"];
}

export type MiningCandidateRefreshFailureReason =
  | "domain-not-found"
  | "domain-not-root"
  | "domain-unanchored"
  | "authorization-lost";

export type MiningCandidateRefreshResult =
  | { ok: true; candidate: MiningCandidate }
  | {
    ok: false;
    reason: MiningCandidateRefreshFailureReason;
    diagnostic: string;
  };

export interface IndexerTruthKey {
  walletRootId: string;
  daemonInstanceId: string;
  snapshotSeq: string;
}

export function getIndexerTruthKey(
  readContext: WalletReadContext & {
    localState: { availability: "ready"; state: WalletStateV1 };
    snapshot: NonNullable<WalletReadContext["snapshot"]>;
  },
): IndexerTruthKey | null {
  if (
    readContext.snapshot.daemonInstanceId == null
    || readContext.snapshot.snapshotSeq == null
  ) {
    return null;
  }

  return {
    walletRootId: readContext.localState.state.walletRootId,
    daemonInstanceId: readContext.snapshot.daemonInstanceId,
    snapshotSeq: readContext.snapshot.snapshotSeq,
  };
}

function bytesToHex(value: Uint8Array | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return Buffer.from(value).toString("hex");
}

function resolveAuthorizationRole(options: {
  domain: {
    ownerScriptPubKey?: Uint8Array | null;
    delegate?: Uint8Array | null;
    miner?: Uint8Array | null;
  };
  walletScriptPubKeyHex: string;
}): MiningCandidateAuthorizationRole | null {
  if (bytesToHex(options.domain.ownerScriptPubKey) === options.walletScriptPubKeyHex) {
    return "owner";
  }

  if (bytesToHex(options.domain.delegate) === options.walletScriptPubKeyHex) {
    return "delegate";
  }

  if (bytesToHex(options.domain.miner) === options.walletScriptPubKeyHex) {
    return "miner";
  }

  return null;
}

function createMiningCandidateProvenance(
  context: ReadyMiningReadContext,
  authorizationRole: MiningCandidateAuthorizationRole,
): MiningCandidateProvenance {
  return {
    walletRootId: context.localState.state.walletRootId,
    walletScriptPubKeyHex: context.model.walletScriptPubKeyHex,
    indexerDaemonInstanceId: context.snapshot.daemonInstanceId ?? context.indexer.daemonInstanceId ?? null,
    indexerSnapshotSeq: context.snapshot.snapshotSeq ?? context.indexer.snapshotSeq ?? null,
    snapshotTipHeight: context.snapshot.tip?.height ?? context.indexer.snapshotTip?.height ?? null,
    snapshotTipHash: context.snapshot.tip?.blockHashHex ?? context.indexer.snapshotTip?.blockHashHex ?? null,
    authorizationRole,
  };
}

async function indexerTruthIsCurrent(options: {
  dataDir: string;
  truthKey: IndexerTruthKey | null;
}): Promise<boolean> {
  if (options.truthKey === null) {
    return false;
  }

  const probe = await probeIndexerDaemon({
    dataDir: options.dataDir,
    walletRootId: options.truthKey.walletRootId,
  });

  try {
    return probe.compatibility === "compatible"
      && probe.status !== null
      && probe.status.state === "synced"
      && probe.status.daemonInstanceId === options.truthKey.daemonInstanceId
      && probe.status.snapshotSeq === options.truthKey.snapshotSeq;
  } finally {
    await probe.client?.close().catch(() => undefined);
  }
}

export async function ensureIndexerTruthIsCurrent(options: {
  dataDir: string;
  truthKey: IndexerTruthKey | null;
}): Promise<void> {
  if (!await indexerTruthIsCurrent(options)) {
    throw new Error("mining_generation_stale_indexer_truth");
  }
}

export function determineCorePublishState(info: {
  blockchain: Awaited<ReturnType<MiningRpcClient["getBlockchainInfo"]>>;
  network: Awaited<ReturnType<MiningRpcClient["getNetworkInfo"]>>;
  mempool: Awaited<ReturnType<MiningRpcClient["getMempoolInfo"]>>;
}): MiningRuntimeStatusV1["corePublishState"] {
  if (info.network.networkactive === false) {
    return "network-inactive";
  }

  if ((info.network.connections_out ?? 0) <= 0) {
    return "no-outbound-peers";
  }

  if (info.blockchain.initialblockdownload === true) {
    return "ibd";
  }

  if (info.mempool.loaded === false) {
    return "mempool-loading";
  }

  return "healthy";
}

export function resolveEligibleAnchoredRoots(context: WalletReadContext): MiningEligibleAnchoredRoot[] {
  const state = context.localState.state;
  const model = context.model;
  const snapshot = context.snapshot;

  if (state === null || model === null || snapshot === null) {
    return [];
  }

  const domains: MiningEligibleAnchoredRoot[] = [];

  for (const domain of model.domains) {
    const mineable = resolveMineableWalletDomain(context, domain);
    if (mineable === null) {
      continue;
    }

    domains.push({
      domainId: mineable.domainId,
      domainName: mineable.domainName,
      localIndex: 0,
      sender: mineable.sender,
    });
  }

  return domains.sort((left, right) => left.domainId - right.domainId || left.domainName.localeCompare(right.domainName));
}

export function refreshMiningCandidateFromCurrentState(
  context: ReadyMiningReadContext,
  candidate: MiningCandidate,
): MiningCandidate | null {
  const result = refreshMiningCandidateFromCurrentStateDetailed(context, candidate);
  return result.ok ? result.candidate : null;
}

export function refreshMiningCandidateFromCurrentStateDetailed(
  context: ReadyMiningReadContext,
  candidate: MiningCandidate,
): MiningCandidateRefreshResult {
  const chainDomain = lookupDomainById(context.snapshot.state, candidate.domainId);
  if (chainDomain === null) {
    return {
      ok: false,
      reason: "domain-not-found",
      diagnostic: `domain_id=${candidate.domainId}`,
    };
  }

  if (chainDomain.name.includes("-")) {
    return {
      ok: false,
      reason: "domain-not-root",
      diagnostic: `domain_id=${candidate.domainId} domain_name=${chainDomain.name}`,
    };
  }

  if (!chainDomain.anchored) {
    return {
      ok: false,
      reason: "domain-unanchored",
      diagnostic: `domain_id=${candidate.domainId} domain_name=${chainDomain.name}`,
    };
  }

  const authorizationRole = resolveAuthorizationRole({
    domain: chainDomain,
    walletScriptPubKeyHex: context.model.walletScriptPubKeyHex,
  });
  if (authorizationRole === null || context.model.walletAddress === null) {
    return {
      ok: false,
      reason: "authorization-lost",
      diagnostic: [
        `domain_id=${candidate.domainId}`,
        `domain_name=${chainDomain.name}`,
        `wallet_script=${context.model.walletScriptPubKeyHex}`,
        `owner_script=${bytesToHex(chainDomain.ownerScriptPubKey) ?? "null"}`,
        `delegate_script=${bytesToHex(chainDomain.delegate) ?? "null"}`,
        `miner_script=${bytesToHex(chainDomain.miner) ?? "null"}`,
        `wallet_address=${context.model.walletAddress ?? "null"}`,
      ].join(" "),
    };
  }

  return {
    ok: true,
    candidate: {
      ...candidate,
      domainName: chainDomain.name,
      localIndex: 0,
      sender: {
        localIndex: 0,
        scriptPubKeyHex: context.model.walletScriptPubKeyHex,
        address: context.model.walletAddress,
      },
      provenance: createMiningCandidateProvenance(context, authorizationRole),
    },
  };
}

export function buildMiningGenerationRequest(options: {
  targetBlockHeight: number;
  referencedBlockHashDisplay: string;
  generatedAtUnixMs?: number;
  requestId?: string;
  domains: Array<{
    domainId: number;
    domainName: string;
    requiredWords: [string, string, string, string, string];
  }>;
  domainExtraPrompts: Record<string, string>;
  fallbackInstruction: string | null;
}): MiningSentenceGenerationRequest {
  return {
    schemaVersion: 1,
    requestId: options.requestId ?? `mining-${options.targetBlockHeight}-${randomBytes(8).toString("hex")}`,
    targetBlockHeight: options.targetBlockHeight,
    referencedBlockHashDisplay: options.referencedBlockHashDisplay,
    generatedAtUnixMs: options.generatedAtUnixMs ?? Date.now(),
    fallbackInstruction: options.fallbackInstruction,
    limits: createMiningSentenceRequestLimits(),
    rootDomains: options.domains.map((domain) => ({
      domainId: domain.domainId,
      domainName: domain.domainName,
      requiredWords: domain.requiredWords,
      domainInstruction: options.domainExtraPrompts[domain.domainName.toLowerCase()] ?? null,
    })),
  };
}

export async function generateCandidatesForDomains(options: {
  rpc: MiningRpcClient;
  readContext: ReadyMiningReadContext;
  domains: MiningEligibleAnchoredRoot[];
  provider: WalletSecretProvider;
  paths: WalletRuntimePaths;
  indexerTruthKey: IndexerTruthKey | null;
  runId?: string | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<MiningCandidate[]> {
  const coreTip = resolveReadContextCoreTip(options.readContext);
  const bestBlockHash = coreTip.hash;

  if (bestBlockHash === null || bestBlockHash === undefined) {
    return [];
  }

  const targetBlockHeight = (coreTip.height ?? 0) + 1;
  const referencedBlockHashInternal = Buffer.from(displayToInternalBlockhash(bestBlockHash), "hex");
  const rootDomains = options.domains.map((domain) => ({
    ...domain,
    requiredWords: getWords(domain.domainId, referencedBlockHashInternal) as [string, string, string, string, string],
  }));
  const clientConfig = await loadClientConfig({
    path: options.paths.clientConfigPath,
    provider: options.provider,
  }).catch(() => null);
  const abortController = new AbortController();
  let stale = false;
  let staleIndexerTruth = false;
  let preempted = false;
  let stopRequested = false;
  const handleStop = () => {
    stopRequested = true;
    abortController.abort(options.signal?.reason ?? createMiningStopRequestedError());
  };
  const timer = setInterval(async () => {
    try {
      const [current, truthCurrent] = await Promise.all([
        options.rpc.getBlockchainInfo(),
        indexerTruthIsCurrent({
          dataDir: options.readContext.dataDir,
          truthKey: options.indexerTruthKey,
        }),
      ]);

      if (current.bestblockhash !== bestBlockHash) {
        stale = true;
        abortController.abort();
        return;
      }

      if (!truthCurrent) {
        staleIndexerTruth = true;
        abortController.abort();
        return;
      }

      if (await isMiningGenerationAbortRequested(options.paths)) {
        preempted = true;
        abortController.abort();
      }
    } catch {
      // Ignore transient polling failures and let the main cycle degrade on the next tick.
    }
  }, BEST_BLOCK_POLL_INTERVAL_MS);

  try {
    if (options.signal?.aborted) {
      handleStop();
    } else {
      options.signal?.addEventListener("abort", handleStop, { once: true });
    }

    await markMiningGenerationActive({
      paths: options.paths,
      runId: options.runId ?? null,
      pid: process.pid ?? null,
    });
    const generationRequest = buildMiningGenerationRequest({
      targetBlockHeight,
      referencedBlockHashDisplay: bestBlockHash,
      domains: rootDomains,
      domainExtraPrompts: clientConfig?.mining.domainExtraPrompts ?? {},
      fallbackInstruction: clientConfig?.mining.builtIn?.extraPrompt ?? null,
    });
    let generated;

    try {
      generated = await Promise.race([
        generateMiningSentences(generationRequest, {
          paths: options.paths,
          provider: options.provider,
          signal: abortController.signal,
          fetchImpl: options.fetchImpl,
        }),
        new Promise<never>((_resolve, reject) => {
          const handleAbort = () => {
            reject(
              abortController.signal.reason instanceof Error
                ? abortController.signal.reason
                : createMiningStopRequestedError(),
            );
          };

          if (abortController.signal.aborted) {
            handleAbort();
            return;
          }

          abortController.signal.addEventListener("abort", handleAbort, { once: true });
        }),
      ]);
    } catch (error) {
      if (stale) {
        throw new Error("mining_generation_stale_tip");
      }

      if (staleIndexerTruth) {
        throw new Error("mining_generation_stale_indexer_truth");
      }

      if (preempted) {
        throw new Error("mining_generation_preempted");
      }

      if (stopRequested || options.signal?.aborted) {
        throw options.signal?.reason instanceof Error
          ? options.signal.reason
          : createMiningStopRequestedError();
      }

      throw error;
    }

    if (stale) {
      throw new Error("mining_generation_stale_tip");
    }

    if (staleIndexerTruth) {
      throw new Error("mining_generation_stale_indexer_truth");
    }

    if (preempted) {
      throw new Error("mining_generation_preempted");
    }

    await ensureIndexerTruthIsCurrent({
      dataDir: options.readContext.dataDir,
      truthKey: options.indexerTruthKey,
    });

    const sentencesByDomain = new Map<number, string[]>();
    for (const candidate of generated.candidates) {
      const existing = sentencesByDomain.get(candidate.domainId) ?? [];
      existing.push(candidate.sentence);
      sentencesByDomain.set(candidate.domainId, existing);
    }

    const candidates: MiningCandidate[] = [];

    for (const domain of rootDomains) {
      const domainSentences = sentencesByDomain.get(domain.domainId) ?? [];

      if (domainSentences.length === 0) {
        continue;
      }

      const assayed = await assaySentences(domain.domainId, referencedBlockHashInternal, domainSentences);
      const best = assayed.find((entry) => entry.gatesPass && entry.encodedSentenceBytes !== null && entry.rank === 1);

      if (best === undefined || best.encodedSentenceBytes === null || best.canonicalBlend === null) {
        continue;
      }

      const candidate: MiningCandidate = {
        domainId: domain.domainId,
        domainName: domain.domainName,
        localIndex: domain.localIndex,
        sender: domain.sender,
        sentence: best.sentence,
        encodedSentenceBytes: best.encodedSentenceBytes,
        bip39WordIndices: [...best.bip39WordIndices],
        bip39Words: best.bip39Words,
        canonicalBlend: best.canonicalBlend,
        referencedBlockHashDisplay: bestBlockHash,
        referencedBlockHashInternal,
        targetBlockHeight,
      };
      const refreshed = refreshMiningCandidateFromCurrentStateDetailed(options.readContext, candidate);
      if (refreshed.ok) {
        candidates.push(refreshed.candidate);
      }
    }

    return candidates;
  } finally {
    clearInterval(timer);
    options.signal?.removeEventListener("abort", handleStop);
    await markMiningGenerationInactive({
      paths: options.paths,
      runId: options.runId ?? null,
      pid: process.pid ?? null,
    }).catch(() => undefined);
  }
}

export async function chooseBestLocalCandidate(candidates: MiningCandidate[]): Promise<MiningCandidate | null> {
  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length === 1) {
    return candidates[0]!;
  }

  const blendSeed = deriveBlendSeed(candidates[0]!.referencedBlockHashInternal);
  const winners = await settleBlock({
    blendSeed,
    blockRewardCogtoshi: 100n,
    submissions: candidates
      .slice()
      .sort((left, right) => left.domainId - right.domainId || left.domainName.localeCompare(right.domainName))
      .map((candidate, index) => ({
        miningDomainId: candidate.domainId,
        rawSentenceBytes: candidate.encodedSentenceBytes,
        recipientScriptPubKey: Buffer.from(candidate.sender.scriptPubKeyHex, "hex"),
        bip39WordIndices: candidate.bip39WordIndices,
        txIndex: index,
      })),
  });
  const winner = winners[0];

  if (winner === undefined) {
    return null;
  }

  return candidates.find((candidate) => candidate.domainId === winner.miningDomainId) ?? null;
}
