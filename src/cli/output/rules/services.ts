import type { CliErrorPresentationRule } from "../types.js";
import {
  getIndexerDaemonStartupLogPath,
  getIndexerDaemonStartupLogTail,
} from "../../../bitcoind/indexer-daemon/startup.js";

function formatIndexerStartupDetail(error: unknown): string | null {
  const logPath = getIndexerDaemonStartupLogPath(error);
  const logTail = getIndexerDaemonStartupLogTail(error);

  if (logPath === null && logTail === null) {
    return null;
  }

  const tail = logTail === null
    ? null
    : logTail.replace(/\s+/g, " ").slice(0, 300);
  return tail === null
    ? `Startup log: ${logPath}.`
    : `Startup log: ${logPath}. Last output: ${tail}`;
}

export const serviceErrorRules: readonly CliErrorPresentationRule[] = [
  ({ errorCode, error }) => {
    if (errorCode.endsWith("_requires_tty") && errorCode !== "cli_update_requires_tty") {
      return {
        what: "Interactive terminal input is required.",
        why: "This command needs terminal input before it can continue safely.",
        next: "Rerun the command in an interactive terminal.",
      };
    }

    if (errorCode.includes("tip_mismatch") || errorCode.includes("stale") || errorCode.includes("catching_up") || errorCode.includes("starting")) {
      return {
        what: "Trusted service state is not ready.",
        why: "The wallet, bitcoind, or indexer is not yet aligned closely enough for this command to proceed safely.",
        next: "Check `cogcoin status`, wait for services to settle, and retry. If the state stays degraded, run `cogcoin repair`.",
      };
    }

    if (errorCode === "sqlite_native_module_unavailable") {
      const detail = formatIndexerStartupDetail(error);
      return {
        what: "The managed indexer daemon could not load its SQLite native module.",
        why: `The active Node runtime is ${process.version}, but the installed native sqlite dependency appears to be missing or built for a different Node ABI.${detail === null ? "" : ` ${detail}`}`,
        next: "Use the supported Node runtime for this checkout, then run `npm rebuild better-sqlite3 zeromq` or reinstall dependencies and retry.",
      };
    }

    if (errorCode === "indexer_daemon_start_failed") {
      const detail = formatIndexerStartupDetail(error);
      return {
        what: "The managed indexer daemon exited before it opened its local IPC socket.",
        why: detail ?? "The daemon process died during startup before Cogcoin could read a service status.",
        next: "Run `cogcoin repair` to clear stale managed indexer artifacts. If this was a local checkout, verify the Node version and rebuild native dependencies.",
      };
    }

    if (errorCode === "indexer_daemon_start_timeout") {
      const detail = formatIndexerStartupDetail(error);
      return {
        what: "The managed indexer daemon stayed alive but did not open its local IPC socket in time.",
        why: detail ?? "Cogcoin could not attach to the daemon before the startup deadline.",
        next: "Run `cogcoin repair` if this persists. If this was a local checkout, verify the Node version and rebuild native dependencies.",
      };
    }

    if (errorCode === "indexer_daemon_background_follow_recovery_failed") {
      return {
        what: "The managed indexer daemon could not recover automatic background follow.",
        why: "Cogcoin tried to resume or restart the compatible managed indexer daemon, but it still failed to enter background follow.",
        next: "Run `cogcoin repair` if this persists, then retry.",
      };
    }

    if (errorCode === "indexer_daemon_service_version_mismatch") {
      return {
        what: "The live indexer daemon is running an incompatible service API version.",
        why: "This wallet only trusts indexer daemons that speak `cogcoin/indexer-ipc/v1`, and the reachable daemon reported a different API version.",
        next: "Run `cogcoin repair` so the wallet can stop the incompatible daemon and restart a compatible managed indexer service.",
      };
    }

    if (errorCode === "indexer_daemon_wallet_root_mismatch") {
      return {
        what: "The live indexer daemon belongs to a different wallet root.",
        why: "Managed indexer daemons are namespaced per wallet root, and the reachable daemon reported a different wallet root than this local wallet.",
        next: "Run `cogcoin repair` so the wallet can stop the conflicting managed daemon and restore the correct local indexer service.",
      };
    }

    if (errorCode === "indexer_daemon_schema_mismatch") {
      return {
        what: "The live indexer daemon is using an incompatible sqlite schema.",
        why: "This wallet only trusts indexer daemons with the expected sqlite schema contract, and the reachable daemon reported a schema mismatch.",
        next: "Run `cogcoin repair` after stopping the incompatible daemon, then retry.",
      };
    }

    if (errorCode === "indexer_daemon_protocol_error") {
      return {
        what: "The live indexer daemon socket is not speaking the expected protocol.",
        why: "A process is bound to the managed indexer socket, but it did not respond with a valid cogcoin indexer IPC status exchange.",
        next: "Run `cogcoin repair` to clear stale managed indexer artifacts and restore a compatible daemon.",
      };
    }

    if (errorCode === "managed_bitcoind_service_version_mismatch" || errorCode.includes("bitcoind_service_version_mismatch")) {
      return {
        what: "The live managed bitcoind service is running an incompatible service version.",
        why: "This wallet only trusts managed bitcoind services that speak `cogcoin/bitcoind-service/v1`, and the reachable service reported a different runtime contract.",
        next: "Run `cogcoin repair` so the wallet can stop the incompatible managed bitcoind service and restart a compatible one.",
      };
    }

    if (errorCode === "managed_bitcoind_wallet_root_mismatch" || errorCode.includes("bitcoind_wallet_root_mismatch")) {
      return {
        what: "The live managed bitcoind service belongs to a different wallet root.",
        why: "Managed bitcoind services are tied to one wallet root, and the reachable service reported a different wallet root than this local wallet expects.",
        next: "Run `cogcoin repair` so the wallet can stop the conflicting managed bitcoind service and restore the correct one.",
      };
    }

    if (errorCode === "managed_bitcoind_runtime_mismatch" || errorCode.includes("bitcoind_runtime_mismatch")) {
      return {
        what: "The live managed bitcoind service runtime does not match this wallet.",
        why: "The reachable service is using a different chain, data directory, or runtime root than this wallet expects, so its status cannot be trusted here.",
        next: "Run `cogcoin repair` so the wallet can clear the conflicting runtime and restart a compatible managed bitcoind service.",
      };
    }

    if (errorCode.includes("bitcoind_replica_missing")) {
      return {
        what: "The managed Core wallet replica is missing.",
        why: "This wallet needs a matching managed Core descriptor-wallet replica before it can safely perform stateful operations.",
        next: "Run `cogcoin repair` to recreate the managed Core wallet replica, then retry.",
      };
    }

    if (errorCode.includes("bitcoind_replica_mismatch")) {
      return {
        what: "The managed Core wallet replica does not match trusted wallet state.",
        why: "The local wallet state and the managed Core replica disagree, so this command refuses to keep going on untrusted Core metadata.",
        next: "Run `cogcoin repair` to recreate or rebind the managed Core wallet replica, then retry.",
      };
    }

    if (errorCode === "mining_preemption_timeout") {
      return {
        what: "Wallet repair is blocked by active mining work.",
        why: "Repair waits for mining generation work to acknowledge preemption before it mutates local indexer runtime artifacts.",
        next: "Pause or stop mining, then rerun `cogcoin repair`.",
      };
    }

    if (errorCode.includes("paused")) {
      return {
        what: "Work is currently paused.",
        why: "Another wallet or mining workflow has priority right now.",
        next: "Wait for the current work to settle, then rerun the command.",
      };
    }

    if (errorCode.includes("setup") || errorCode.includes("validation") || errorCode.includes("core_replica_not_ready")) {
      return {
        what: "Local setup is incomplete.",
        why: "This command depends on a local component that is not ready yet.",
        next: "Review the local status output, finish the required setup or repair step, and retry.",
      };
    }

    return null;
  },
];
