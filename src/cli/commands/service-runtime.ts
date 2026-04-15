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

interface ServiceStatusEntry {
  text: string;
  ok: boolean;
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

function serviceStatusEntry(label: string, value: string, ok: boolean): ServiceStatusEntry {
  return {
    text: `${label}: ${value}`,
    ok,
  };
}

function formatServiceStatusSection(header: string, entries: readonly ServiceStatusEntry[]): string {
  return [header, ...entries.map((entry) => `${entry.ok ? "✓" : "✗"} ${entry.text}`)].join("\n");
}

function formatSectionedServiceStatusReport(options: {
  title: string;
  sections: Array<{
    header: string;
    entries: ServiceStatusEntry[];
  }>;
  nextStep: string | null;
}): string {
  const parts = [
    `\n⛭ ${options.title} ⛭`,
    ...options.sections.map((section) => formatServiceStatusSection(section.header, section.entries)),
  ];

  if (options.nextStep !== null) {
    parts.push(`Next step: ${options.nextStep}`);
  }

  return parts.join("\n\n");
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
  const compatibilityOk = payload.compatibility === "compatible";
  const serviceStateOk = payload.service?.state === "ready";
  const nodeOk = payload.node !== null && payload.nodeError === null;
  const managedServiceEntries = [
    serviceStatusEntry("Compatibility", formatCompatibility(payload.compatibility), compatibilityOk),
  ];

  if (payload.service !== null) {
    managedServiceEntries.push(serviceStatusEntry("Service state", payload.service.state, serviceStateOk));
    managedServiceEntries.push(serviceStatusEntry("Process id", formatMaybe(payload.service.processId), serviceStateOk));
    managedServiceEntries.push(serviceStatusEntry("Service instance", payload.service.serviceInstanceId, serviceStateOk));
    managedServiceEntries.push(serviceStatusEntry("Runtime root", payload.service.runtimeRoot, serviceStateOk));
    managedServiceEntries.push(serviceStatusEntry("Chain", payload.service.chain, serviceStateOk));
    managedServiceEntries.push(serviceStatusEntry("RPC", payload.service.rpc.url, serviceStateOk));
    managedServiceEntries.push(serviceStatusEntry("RPC cookie", payload.service.rpc.cookieFile, serviceStateOk));
    managedServiceEntries.push(serviceStatusEntry("ZMQ", payload.service.zmq.endpoint, serviceStateOk));
    managedServiceEntries.push(serviceStatusEntry("P2P port", String(payload.service.p2pPort), serviceStateOk));
    managedServiceEntries.push(serviceStatusEntry("Started at", String(payload.service.startedAtUnixMs), serviceStateOk));
    managedServiceEntries.push(serviceStatusEntry("Heartbeat at", String(payload.service.heartbeatAtUnixMs), serviceStateOk));
    managedServiceEntries.push(serviceStatusEntry("Updated at", String(payload.service.updatedAtUnixMs), serviceStateOk));
    managedServiceEntries.push(serviceStatusEntry(
      "Managed Core wallet",
      payload.service.walletReplica?.proofStatus ?? "unavailable",
      payload.service.walletReplica?.proofStatus === "ready",
    ));
    if (payload.service.lastError !== null) {
      managedServiceEntries.push(serviceStatusEntry("Service error", payload.service.lastError, false));
    }
  } else {
    managedServiceEntries.push(serviceStatusEntry("Service state", "unavailable", false));
  }

  const bitcoinNodeEntries = payload.node !== null
    ? [
      serviceStatusEntry("Best height", String(payload.node.bestHeight), nodeOk),
      serviceStatusEntry("Headers", String(payload.node.headerHeight), nodeOk),
      serviceStatusEntry("Best hash", payload.node.bestHash, nodeOk),
      serviceStatusEntry("Verification progress", formatMaybe(payload.node.verificationProgress), nodeOk),
      serviceStatusEntry("Initial block download", formatBool(payload.node.initialBlockDownload), nodeOk),
      serviceStatusEntry("Network active", formatBool(payload.node.networkActive), nodeOk),
      serviceStatusEntry("Connections", String(payload.node.connections), nodeOk),
      serviceStatusEntry("Inbound connections", formatMaybe(payload.node.inboundConnections), nodeOk),
      serviceStatusEntry("Outbound connections", formatMaybe(payload.node.outboundConnections), nodeOk),
    ]
    : [serviceStatusEntry("Node state", "unavailable", false)];

  if (payload.nodeError !== null) {
    bitcoinNodeEntries.push(serviceStatusEntry("Node error", payload.nodeError, false));
  }

  return formatSectionedServiceStatusReport({
    title: "Bitcoin Status",
    sections: [
      {
        header: "Paths",
        entries: [
          serviceStatusEntry("Bitcoin datadir", payload.dataDir, true),
          serviceStatusEntry("Wallet root", payload.walletRootId, true),
          serviceStatusEntry("Wallet root source", payload.walletRootSource, true),
        ],
      },
      {
        header: "Managed Service",
        entries: managedServiceEntries,
      },
      {
        header: "Bitcoin Node",
        entries: bitcoinNodeEntries,
      },
    ],
    nextStep: payload.compatibility === "unreachable"
      ? "Run `cogcoin bitcoin start` to start the managed Bitcoin service."
      : null,
  });
}

function formatIndexerStatusReport(payload: IndexerStatusPayload): string {
  const compatibilityOk = payload.compatibility === "compatible";
  const observedSourceOk = payload.source === "probe";
  const daemonStateOk = payload.daemon?.state === "synced";
  const managedServiceEntries = [
    serviceStatusEntry("Compatibility", formatCompatibility(payload.compatibility), compatibilityOk),
    serviceStatusEntry("Observed source", payload.source, observedSourceOk),
  ];

  if (payload.daemon !== null) {
    managedServiceEntries.push(serviceStatusEntry("Daemon state", payload.daemon.state, daemonStateOk));
    managedServiceEntries.push(serviceStatusEntry("Process id", formatMaybe(payload.daemon.processId), daemonStateOk));
    managedServiceEntries.push(serviceStatusEntry("Daemon instance", payload.daemon.daemonInstanceId, daemonStateOk));
    managedServiceEntries.push(serviceStatusEntry("Runtime root", payload.daemon.runtimeRoot, daemonStateOk));
    managedServiceEntries.push(serviceStatusEntry("Schema version", payload.daemon.schemaVersion, daemonStateOk));
    managedServiceEntries.push(serviceStatusEntry("Started at", String(payload.daemon.startedAtUnixMs), daemonStateOk));
    managedServiceEntries.push(serviceStatusEntry("Heartbeat at", String(payload.daemon.heartbeatAtUnixMs), daemonStateOk));
    managedServiceEntries.push(serviceStatusEntry("Updated at", String(payload.daemon.updatedAtUnixMs), daemonStateOk));
    managedServiceEntries.push(serviceStatusEntry("IPC ready", formatBool(payload.daemon.ipcReady), payload.daemon.ipcReady));
    managedServiceEntries.push(serviceStatusEntry("RPC reachable", formatBool(payload.daemon.rpcReachable), payload.daemon.rpcReachable));
    if (payload.daemon.lastError !== null) {
      managedServiceEntries.push(serviceStatusEntry("Daemon error", payload.daemon.lastError, false));
    }
  } else {
    managedServiceEntries.push(serviceStatusEntry("Daemon state", "unavailable", false));
  }

  const indexerStateEntries = payload.daemon !== null
    ? [
      serviceStatusEntry("Core best height", formatMaybe(payload.daemon.coreBestHeight), daemonStateOk),
      serviceStatusEntry("Core best hash", formatMaybe(payload.daemon.coreBestHash), daemonStateOk),
      serviceStatusEntry("Applied tip height", formatMaybe(payload.daemon.appliedTipHeight), daemonStateOk),
      serviceStatusEntry("Applied tip hash", formatMaybe(payload.daemon.appliedTipHash), daemonStateOk),
      serviceStatusEntry("Snapshot sequence", formatMaybe(payload.daemon.snapshotSeq), daemonStateOk),
      serviceStatusEntry("Backlog blocks", formatMaybe(payload.daemon.backlogBlocks), daemonStateOk),
      serviceStatusEntry("Reorg depth", formatMaybe(payload.daemon.reorgDepth), daemonStateOk),
      serviceStatusEntry("Active snapshots", String(payload.daemon.activeSnapshotCount), daemonStateOk),
      serviceStatusEntry("Last applied at", formatMaybe(payload.daemon.lastAppliedAtUnixMs), daemonStateOk),
    ]
    : [serviceStatusEntry("Daemon state", "unavailable", false)];

  return formatSectionedServiceStatusReport({
    title: "Indexer Status",
    sections: [
      {
        header: "Paths",
        entries: [
          serviceStatusEntry("Bitcoin datadir", payload.dataDir, true),
          serviceStatusEntry("Wallet root", payload.walletRootId, true),
          serviceStatusEntry("Wallet root source", payload.walletRootSource, true),
        ],
      },
      {
        header: "Managed Service",
        entries: managedServiceEntries,
      },
      {
        header: "Indexer State",
        entries: indexerStateEntries,
      },
    ],
    nextStep: payload.compatibility === "unreachable"
      ? "Run `cogcoin indexer start` to start the managed Cogcoin indexer."
      : null,
  });
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
