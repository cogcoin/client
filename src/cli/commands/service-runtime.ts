import { dirname } from "node:path";

import { loadBundledGenesisParameters } from "@cogcoin/indexer";

import type { ManagedBitcoindServiceCompatibility } from "../../bitcoind/service.js";
import { UNINITIALIZED_WALLET_ROOT_ID, resolveManagedServicePaths } from "../../bitcoind/service-paths.js";
import type { IndexerDaemonCompatibility } from "../../bitcoind/indexer-daemon.js";
import type {
  ManagedBitcoindObservedStatus,
  ManagedIndexerDaemonObservedStatus,
} from "../../bitcoind/types.js";
import {
  resolveWalletRootIdFromLocalArtifacts,
  type WalletRootResolution,
  type WalletRootResolutionSource,
} from "../../wallet/root-resolution.js";
import { writeLine } from "../io.js";
import {
  createSuccessEnvelope,
  describeCanonicalCommand,
  writeHandledCliError,
  writeJsonValue,
} from "../output.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";

type WalletRootSource = WalletRootResolutionSource;

interface BitcoinNodeSnapshot {
  bestHeight: number;
  headerHeight: number;
  bestHash: string;
  verificationProgress: number | null;
  initialBlockDownload: boolean | null;
  networkActive: boolean;
  connections: number;
  inboundConnections: number | null;
  outboundConnections: number | null;
}

interface BitcoinStatusPayload {
  dataDir: string;
  walletRootId: string;
  walletRootSource: WalletRootSource;
  compatibility: ManagedBitcoindServiceCompatibility;
  service: ManagedBitcoindObservedStatus | null;
  node: BitcoinNodeSnapshot | null;
  nodeError: string | null;
}

interface IndexerStatusPayload {
  dataDir: string;
  walletRootId: string;
  walletRootSource: WalletRootSource;
  compatibility: IndexerDaemonCompatibility;
  source: "probe" | "status-file" | "none";
  daemon: (ManagedIndexerDaemonObservedStatus & {
    runtimeRoot: string;
  }) | null;
}

function formatBool(value: boolean | null): string {
  return value === null ? "unknown" : (value ? "yes" : "no");
}

function formatMaybe(value: number | string | null | undefined): string {
  return value === null || value === undefined ? "unavailable" : String(value);
}

function formatCompatibility(value: string): string {
  return value.replaceAll("-", " ");
}

async function resolveEffectiveWalletRootId(
  context: RequiredCliRunnerContext,
): Promise<WalletRootResolution> {
  return resolveWalletRootIdFromLocalArtifacts({
    paths: context.resolveWalletRuntimePaths(),
    provider: context.walletSecretProvider,
    loadRawWalletStateEnvelope: context.loadRawWalletStateEnvelope,
    loadUnlockSession: context.loadUnlockSession,
    loadWalletExplicitLock: context.loadWalletExplicitLock,
  }).catch(() => ({
    walletRootId: UNINITIALIZED_WALLET_ROOT_ID,
    source: "default-uninitialized",
  }));
}

async function inspectManagedBitcoindStatus(
  dataDir: string,
  context: RequiredCliRunnerContext,
): Promise<BitcoinStatusPayload> {
  const resolution = await resolveEffectiveWalletRootId(context);
  const probe = await context.probeManagedBitcoindService({
    dataDir,
    chain: "main",
    startHeight: 0,
    walletRootId: resolution.walletRootId,
  });

  let node: BitcoinNodeSnapshot | null = null;
  let nodeError: string | null = null;

  if (probe.compatibility === "compatible" && probe.status !== null) {
    try {
      const rpc = context.createBitcoinRpcClient(probe.status.rpc);
      const [blockchainInfo, networkInfo] = await Promise.all([
        rpc.getBlockchainInfo(),
        rpc.getNetworkInfo(),
      ]);
      node = {
        bestHeight: blockchainInfo.blocks,
        headerHeight: blockchainInfo.headers,
        bestHash: blockchainInfo.bestblockhash,
        verificationProgress: blockchainInfo.verificationprogress ?? null,
        initialBlockDownload: blockchainInfo.initialblockdownload ?? null,
        networkActive: networkInfo.networkactive,
        connections: networkInfo.connections,
        inboundConnections: networkInfo.connections_in ?? null,
        outboundConnections: networkInfo.connections_out ?? null,
      };
    } catch (error) {
      nodeError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    dataDir,
    walletRootId: resolution.walletRootId,
    walletRootSource: resolution.source,
    compatibility: probe.compatibility,
    service: probe.status,
    node,
    nodeError,
  };
}

async function inspectManagedIndexerStatus(
  dataDir: string,
  context: RequiredCliRunnerContext,
): Promise<IndexerStatusPayload> {
  const resolution = await resolveEffectiveWalletRootId(context);
  const runtimeRoot = resolveManagedServicePaths(dataDir, resolution.walletRootId).walletRuntimeRoot;
  const probe = await context.probeIndexerDaemon({
    dataDir,
    walletRootId: resolution.walletRootId,
  });

  let source: "probe" | "status-file" | "none" = "probe";
  let daemon = probe.status;

  if (probe.compatibility === "unreachable") {
    daemon = await context.readObservedIndexerDaemonStatus({
      dataDir,
      walletRootId: resolution.walletRootId,
    });
    source = daemon === null ? "none" : "status-file";
  }

  return {
    dataDir,
    walletRootId: resolution.walletRootId,
    walletRootSource: resolution.source,
    compatibility: probe.compatibility,
    source,
    daemon: daemon === null
      ? null
      : {
        ...daemon,
        runtimeRoot,
      },
  };
}

function formatBitcoinStatusReport(payload: BitcoinStatusPayload): string {
  const lines = [
    "Managed Bitcoind Status",
    `Bitcoin datadir: ${payload.dataDir}`,
    `Wallet root: ${payload.walletRootId}`,
    `Wallet root source: ${payload.walletRootSource}`,
    `Compatibility: ${formatCompatibility(payload.compatibility)}`,
  ];

  if (payload.service !== null) {
    lines.push(`Service state: ${payload.service.state}`);
    lines.push(`Process id: ${formatMaybe(payload.service.processId)}`);
    lines.push(`Service instance: ${payload.service.serviceInstanceId}`);
    lines.push(`Runtime root: ${payload.service.runtimeRoot}`);
    lines.push(`Chain: ${payload.service.chain}`);
    lines.push(`RPC: ${payload.service.rpc.url}`);
    lines.push(`RPC cookie: ${payload.service.rpc.cookieFile}`);
    lines.push(`ZMQ: ${payload.service.zmq.endpoint}`);
    lines.push(`P2P port: ${payload.service.p2pPort}`);
    lines.push(`Started at: ${payload.service.startedAtUnixMs}`);
    lines.push(`Heartbeat at: ${payload.service.heartbeatAtUnixMs}`);
    lines.push(`Updated at: ${payload.service.updatedAtUnixMs}`);
    lines.push(`Managed Core wallet: ${payload.service.walletReplica?.proofStatus ?? "unavailable"}`);
    if (payload.service.lastError !== null) {
      lines.push(`Service error: ${payload.service.lastError}`);
    }
  } else {
    lines.push("Service state: unavailable");
  }

  if (payload.node !== null) {
    lines.push(`Bitcoin best height: ${payload.node.bestHeight}`);
    lines.push(`Bitcoin headers: ${payload.node.headerHeight}`);
    lines.push(`Bitcoin best hash: ${payload.node.bestHash}`);
    lines.push(`Verification progress: ${formatMaybe(payload.node.verificationProgress)}`);
    lines.push(`Initial block download: ${formatBool(payload.node.initialBlockDownload)}`);
    lines.push(`Network active: ${formatBool(payload.node.networkActive)}`);
    lines.push(`Connections: ${payload.node.connections}`);
    lines.push(`Inbound connections: ${formatMaybe(payload.node.inboundConnections)}`);
    lines.push(`Outbound connections: ${formatMaybe(payload.node.outboundConnections)}`);
  } else {
    lines.push("Bitcoin node: unavailable");
  }

  if (payload.nodeError !== null) {
    lines.push(`Node error: ${payload.nodeError}`);
  }

  if (payload.compatibility === "unreachable") {
    lines.push("Recommended next step: Run `cogcoin bitcoin start` to start the managed Bitcoin service.");
  }

  return `${lines.join("\n")}\n`;
}

function formatIndexerStatusReport(payload: IndexerStatusPayload): string {
  const lines = [
    "Managed Indexer Status",
    `Bitcoin datadir: ${payload.dataDir}`,
    `Wallet root: ${payload.walletRootId}`,
    `Wallet root source: ${payload.walletRootSource}`,
    `Compatibility: ${formatCompatibility(payload.compatibility)}`,
    `Observed source: ${payload.source}`,
  ];

  if (payload.daemon !== null) {
    lines.push(`Daemon state: ${payload.daemon.state}`);
    lines.push(`Process id: ${formatMaybe(payload.daemon.processId)}`);
    lines.push(`Daemon instance: ${payload.daemon.daemonInstanceId}`);
    lines.push(`Runtime root: ${payload.daemon.runtimeRoot}`);
    lines.push(`Schema version: ${payload.daemon.schemaVersion}`);
    lines.push(`Started at: ${payload.daemon.startedAtUnixMs}`);
    lines.push(`Heartbeat at: ${payload.daemon.heartbeatAtUnixMs}`);
    lines.push(`Updated at: ${payload.daemon.updatedAtUnixMs}`);
    lines.push(`IPC ready: ${formatBool(payload.daemon.ipcReady)}`);
    lines.push(`RPC reachable: ${formatBool(payload.daemon.rpcReachable)}`);
    lines.push(`Core best height: ${formatMaybe(payload.daemon.coreBestHeight)}`);
    lines.push(`Core best hash: ${formatMaybe(payload.daemon.coreBestHash)}`);
    lines.push(`Applied tip height: ${formatMaybe(payload.daemon.appliedTipHeight)}`);
    lines.push(`Applied tip hash: ${formatMaybe(payload.daemon.appliedTipHash)}`);
    lines.push(`Snapshot sequence: ${formatMaybe(payload.daemon.snapshotSeq)}`);
    lines.push(`Backlog blocks: ${formatMaybe(payload.daemon.backlogBlocks)}`);
    lines.push(`Reorg depth: ${formatMaybe(payload.daemon.reorgDepth)}`);
    lines.push(`Active snapshots: ${payload.daemon.activeSnapshotCount}`);
    lines.push(`Last applied at: ${formatMaybe(payload.daemon.lastAppliedAtUnixMs)}`);
    if (payload.daemon.lastError !== null) {
      lines.push(`Daemon error: ${payload.daemon.lastError}`);
    }
  } else {
    lines.push("Daemon state: unavailable");
  }

  if (payload.compatibility === "unreachable") {
    lines.push("Recommended next step: Run `cogcoin indexer start` to start the managed Cogcoin indexer.");
  }

  return `${lines.join("\n")}\n`;
}

function buildStatusMessages(payload: BitcoinStatusPayload | IndexerStatusPayload): {
  warnings: string[];
  explanations: string[];
  nextSteps: string[];
} {
  const warnings: string[] = [];
  const explanations: string[] = [];
  const nextSteps: string[] = [];

  if (payload.compatibility !== "compatible") {
    warnings.push(`Managed service compatibility is ${payload.compatibility}.`);
  }

  if ("nodeError" in payload && payload.nodeError !== null) {
    explanations.push(payload.nodeError);
  }

  if ("service" in payload && payload.service?.lastError) {
    explanations.push(payload.service.lastError);
  }

  if ("daemon" in payload && payload.daemon?.lastError) {
    explanations.push(payload.daemon.lastError);
  }

  if ("service" in payload && payload.compatibility === "unreachable") {
    nextSteps.push("Run `cogcoin bitcoin start` to start the managed Bitcoin service.");
  }

  if ("daemon" in payload && payload.compatibility === "unreachable") {
    nextSteps.push("Run `cogcoin indexer start` to start the managed Cogcoin indexer.");
  }

  return {
    warnings,
    explanations,
    nextSteps,
  };
}

export async function runServiceRuntimeCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  try {
    const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();

    if (parsed.command === "bitcoin-status") {
      const payload = await inspectManagedBitcoindStatus(dataDir, context);
      const messages = buildStatusMessages(payload);
      if (parsed.outputMode === "json") {
        writeJsonValue(context.stdout, createSuccessEnvelope(
          "cogcoin/bitcoin-status/v1",
          describeCanonicalCommand(parsed),
          payload,
          messages,
        ));
        return 0;
      }
      context.stdout.write(formatBitcoinStatusReport(payload));
      return 0;
    }

    if (parsed.command === "indexer-status") {
      const payload = await inspectManagedIndexerStatus(dataDir, context);
      const messages = buildStatusMessages(payload);
      if (parsed.outputMode === "json") {
        writeJsonValue(context.stdout, createSuccessEnvelope(
          "cogcoin/indexer-status/v1",
          describeCanonicalCommand(parsed),
          payload,
          messages,
        ));
        return 0;
      }
      context.stdout.write(formatIndexerStatusReport(payload));
      return 0;
    }

    if (parsed.command === "bitcoin-start") {
      const resolution = await resolveEffectiveWalletRootId(context);
      const probe = await context.probeManagedBitcoindService({
        dataDir,
        chain: "main",
        startHeight: 0,
        walletRootId: resolution.walletRootId,
      });
      const genesis = await loadBundledGenesisParameters();
      await context.attachManagedBitcoindService({
        dataDir,
        chain: "main",
        startHeight: genesis.genesisBlock,
        walletRootId: resolution.walletRootId,
      });
      const bitcoindStatus = probe.compatibility === "compatible" ? "already-running" : "started";
      const payload = {
        dataDir,
        walletRootId: resolution.walletRootId,
        walletRootSource: resolution.source,
        bitcoind: {
          status: bitcoindStatus,
        },
      };

      if (parsed.outputMode === "json") {
        writeJsonValue(context.stdout, createSuccessEnvelope(
          "cogcoin/bitcoin-start/v1",
          describeCanonicalCommand(parsed),
          payload,
          {
            nextSteps: [
              "Run `cogcoin bitcoin status` to inspect the managed Bitcoin node.",
              "Run `cogcoin indexer start` or `cogcoin sync` when you want the managed Cogcoin indexer.",
            ],
          },
        ));
        return 0;
      }

      writeLine(
        context.stdout,
        bitcoindStatus === "already-running" ? "Managed bitcoind already running." : "Managed bitcoind started.",
      );
      writeLine(context.stdout, `Wallet root: ${resolution.walletRootId}`);
      return 0;
    }

    if (parsed.command === "bitcoin-stop") {
      const resolution = await resolveEffectiveWalletRootId(context);
      const indexer = await context.stopIndexerDaemonService({
        dataDir,
        walletRootId: resolution.walletRootId,
      });
      const bitcoind = await context.stopManagedBitcoindService({
        dataDir,
        walletRootId: resolution.walletRootId,
      });
      const payload = {
        dataDir,
        walletRootId: resolution.walletRootId,
        walletRootSource: resolution.source,
        bitcoind,
        indexer,
      };

      if (parsed.outputMode === "json") {
        writeJsonValue(context.stdout, createSuccessEnvelope(
          "cogcoin/bitcoin-stop/v1",
          describeCanonicalCommand(parsed),
          payload,
        ));
        return 0;
      }

      writeLine(
        context.stdout,
        bitcoind.status === "stopped" ? "Managed bitcoind stopped." : "Managed bitcoind already stopped.",
      );
      writeLine(
        context.stdout,
        indexer.status === "stopped" ? "Paired indexer stopped." : "Paired indexer already stopped.",
      );
      return 0;
    }

    if (parsed.command === "indexer-start") {
      const resolution = await resolveEffectiveWalletRootId(context);
      const dbPath = parsed.dbPath ?? context.resolveDefaultClientDatabasePath();
      await context.ensureDirectory(dirname(dbPath));
      const genesis = await loadBundledGenesisParameters();
      const bitcoindProbe = await context.probeManagedBitcoindService({
        dataDir,
        chain: "main",
        startHeight: 0,
        walletRootId: resolution.walletRootId,
      });
      await context.attachManagedBitcoindService({
        dataDir,
        chain: "main",
        startHeight: genesis.genesisBlock,
        walletRootId: resolution.walletRootId,
      });
      const indexerProbe = await context.probeIndexerDaemon({
        dataDir,
        walletRootId: resolution.walletRootId,
      });
      await context.attachIndexerDaemon({
        dataDir,
        databasePath: dbPath,
        walletRootId: resolution.walletRootId,
      });
      const payload = {
        dataDir,
        databasePath: dbPath,
        walletRootId: resolution.walletRootId,
        walletRootSource: resolution.source,
        bitcoind: {
          status: bitcoindProbe.compatibility === "compatible" ? "already-running" : "started",
        },
        indexer: {
          status: indexerProbe.compatibility === "compatible" ? "already-running" : "started",
        },
      };

      if (parsed.outputMode === "json") {
        writeJsonValue(context.stdout, createSuccessEnvelope(
          "cogcoin/indexer-start/v1",
          describeCanonicalCommand(parsed),
          payload,
          {
            nextSteps: [
              "Run `cogcoin indexer status` to inspect the managed Cogcoin indexer.",
            ],
          },
        ));
        return 0;
      }

      writeLine(
        context.stdout,
        payload.indexer.status === "already-running" ? "Managed indexer already running." : "Managed indexer started.",
      );
      if (payload.bitcoind.status === "started") {
        writeLine(context.stdout, "Managed bitcoind started automatically.");
      }
      return 0;
    }

    if (parsed.command === "indexer-stop") {
      const resolution = await resolveEffectiveWalletRootId(context);
      const indexer = await context.stopIndexerDaemonService({
        dataDir,
        walletRootId: resolution.walletRootId,
      });
      const payload = {
        dataDir,
        walletRootId: resolution.walletRootId,
        walletRootSource: resolution.source,
        indexer,
      };

      if (parsed.outputMode === "json") {
        writeJsonValue(context.stdout, createSuccessEnvelope(
          "cogcoin/indexer-stop/v1",
          describeCanonicalCommand(parsed),
          payload,
        ));
        return 0;
      }

      writeLine(
        context.stdout,
        indexer.status === "stopped" ? "Managed indexer stopped." : "Managed indexer already stopped.",
      );
      return 0;
    }

    throw new Error(`service runtime command not implemented: ${parsed.command}`);
  } catch (error) {
    return writeHandledCliError({
      parsed,
      stdout: context.stdout,
      stderr: context.stderr,
      error,
    });
  }
}
