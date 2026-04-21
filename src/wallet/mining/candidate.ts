import { randomBytes } from "node:crypto";

import {
  assaySentences,
  deriveBlendSeed,
  displayToInternalBlockhash,
  getWords,
  settleBlock,
} from "@cogcoin/scoring";
import { probeIndexerDaemon } from "../../bitcoind/indexer-daemon.js";
import { loadClientConfig } from "./config.js";
import {
  isMiningGenerationAbortRequested,
  markMiningGenerationActive,
  markMiningGenerationInactive,
} from "./coordination.js";
import type { MiningCandidate, MiningRpcClient, ReadyMiningReadContext } from "./engine-types.js";
import type { WalletRuntimePaths } from "../runtime.js";
import type { WalletSecretProvider } from "../state/provider.js";
import type { WalletReadContext } from "../read/index.js";
import type { WalletStateV1 } from "../types.js";
import type { MiningRuntimeStatusV1 } from "./types.js";
import { createMiningSentenceRequestLimits } from "./sentence-protocol.js";
import { generateMiningSentences, type MiningSentenceGenerationRequest } from "./sentences.js";
import { createMiningStopRequestedError } from "./stop.js";
import { isMineableWalletDomain } from "../read/index.js";
import { lookupDomain } from "@cogcoin/indexer/queries";

const BEST_BLOCK_POLL_INTERVAL_MS = 500;

export interface MiningEligibleAnchoredRoot {
  domainId: number;
  domainName: string;
  localIndex: number;
  sender: MiningCandidate["sender"];
}

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
    if (!isMineableWalletDomain(context, domain)) {
      continue;
    }

    const domainId = domain.domainId;

    if (
      domainId === null
      || domainId === undefined
      || domain.ownerAddress == null
      || domain.ownerScriptPubKeyHex !== model.walletScriptPubKeyHex
    ) {
      continue;
    }

    const chainDomain = lookupDomain(snapshot.state, domain.name);
    if (chainDomain === null || !chainDomain.anchored) {
      continue;
    }

    domains.push({
      domainId,
      domainName: domain.name,
      localIndex: 0,
      sender: {
        localIndex: 0,
        scriptPubKeyHex: model.walletScriptPubKeyHex,
        address: domain.ownerAddress,
      },
    });
  }

  return domains.sort((left, right) => left.domainId - right.domainId || left.domainName.localeCompare(right.domainName));
}

export function refreshMiningCandidateFromCurrentState(
  context: ReadyMiningReadContext,
  candidate: MiningCandidate,
): MiningCandidate | null {
  const refreshed = resolveEligibleAnchoredRoots(context).find((domain) => domain.domainId === candidate.domainId);
  if (refreshed === undefined) {
    return null;
  }

  return {
    ...candidate,
    domainName: refreshed.domainName,
    localIndex: refreshed.localIndex,
    sender: refreshed.sender,
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
  extraPrompt: string | null;
}): MiningSentenceGenerationRequest {
  return {
    schemaVersion: 1,
    requestId: options.requestId ?? `mining-${options.targetBlockHeight}-${randomBytes(8).toString("hex")}`,
    targetBlockHeight: options.targetBlockHeight,
    referencedBlockHashDisplay: options.referencedBlockHashDisplay,
    generatedAtUnixMs: options.generatedAtUnixMs ?? Date.now(),
    extraPrompt: options.extraPrompt,
    limits: createMiningSentenceRequestLimits(),
    rootDomains: options.domains.map((domain) => ({
      domainId: domain.domainId,
      domainName: domain.domainName,
      requiredWords: domain.requiredWords,
      extraPrompt: options.domainExtraPrompts[domain.domainName.toLowerCase()] ?? null,
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
  const bestBlockHash = options.readContext.nodeStatus?.nodeBestHashHex;

  if (bestBlockHash === null || bestBlockHash === undefined) {
    return [];
  }

  const targetBlockHeight = (options.readContext.nodeStatus?.nodeBestHeight ?? 0) + 1;
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
      extraPrompt: clientConfig?.mining.builtIn?.extraPrompt ?? null,
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

      candidates.push({
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
      });
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
