import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { resolveManagedServicePaths } from "../src/bitcoind/service-paths.js";
import { repairManagedBitcoindStage } from "../src/wallet/lifecycle/repair-bitcoind.js";
import { resolveWalletRepairContext } from "../src/wallet/lifecycle/context.js";
import { loadWalletState } from "../src/wallet/state/storage.js";
import {
  createDerivedWalletState,
  createManagedCoreRpcHarness,
  createWalletLifecycleFixture,
} from "./wallet-lifecycle-test-helpers.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function installProcessKillMock(t: TestContext, livePids: readonly number[]) {
  const originalKill = process.kill;
  const alive = new Set(livePids);
  const calls: Array<{ pid: number; signal: number | NodeJS.Signals | undefined }> = [];

  (process as typeof process & {
    kill: typeof process.kill;
  }).kill = ((pid: number, signal?: number | NodeJS.Signals) => {
    calls.push({ pid, signal });

    if (!alive.has(pid)) {
      const error = Object.assign(new Error("process not found"), {
        code: "ESRCH",
      });
      throw error;
    }

    if (signal === undefined || signal === 0) {
      return true;
    }

    if (signal === "SIGTERM") {
      alive.delete(pid);
      return true;
    }

    return true;
  }) as typeof process.kill;

  t.after(() => {
    (process as typeof process & {
      kill: typeof process.kill;
    }).kill = originalKill;
  });

  return {
    calls,
  };
}

test("repairManagedBitcoindStage stops incompatible services and normalizes state through the extracted owner", async (t) => {
  const state = createDerivedWalletState({
    descriptorChecksum: "abcd1234",
  });
  state.descriptor.checksum = "stale";
  state.managedCoreWallet.walletScriptPubKeyHex = null;
  const fixture = await createWalletLifecycleFixture(t, { state });
  const servicePaths = resolveManagedServicePaths(fixture.dataDir, state.walletRootId);
  const killLog = installProcessKillMock(t, [8_111]);
  const harness = createManagedCoreRpcHarness({
    mnemonic: state.mnemonic.phrase,
    loadedWallets: [state.managedCoreWallet.walletName],
  });
  const attachService = async (...args: Parameters<NonNullable<typeof harness.dependencies.attachService>>) => {
    const handle = await harness.dependencies.attachService!(...args);
    return {
      ...handle,
      refreshServiceStatus: async () => ({ state: "ready" }),
    } as any;
  };

  await writeJsonFile(servicePaths.bitcoindStatusPath, {
    processId: 8_111,
  });
  await writeJsonFile(servicePaths.bitcoindPidPath, {
    processId: 8_111,
  });

  const context = resolveWalletRepairContext({
    dataDir: fixture.dataDir,
    databasePath: fixture.databasePath,
    provider: fixture.provider,
    paths: fixture.paths,
    nowUnixMs: 123,
    probeBitcoindService: async () => ({
      compatibility: "service-version-mismatch",
      status: {
        processId: 8_111,
      },
      error: null,
    }) as any,
    attachService,
    rpcFactory: harness.dependencies.rpcFactory,
  });

  const result = await repairManagedBitcoindStage({
    context,
    servicePaths,
    state,
    recoveredFromBackup: false,
    repairStateNeedsPersist: false,
  });

  assert.equal(result.bitcoindServiceAction, "stopped-incompatible-service");
  assert.equal(result.bitcoindCompatibilityIssue, "service-version-mismatch");
  assert.equal(result.bitcoindPostRepairHealth, "ready");
  assert.equal(result.state.descriptor.checksum, "abcd1234");
  assert.equal(result.state.managedCoreWallet.walletScriptPubKeyHex, state.funding.scriptPubKeyHex);
  assert.deepEqual(
    killLog.calls.map((call) => [call.pid, call.signal]),
    [
      [8_111, "SIGTERM"],
      [8_111, 0],
    ],
  );
  assert.equal(await pathExists(servicePaths.bitcoindStatusPath), false);
  assert.equal(await pathExists(servicePaths.bitcoindPidPath), false);

  const saved = await loadWalletState(
    {
      primaryPath: fixture.paths.walletStatePath,
      backupPath: fixture.paths.walletStateBackupPath,
    },
    {
      provider: fixture.provider,
    },
  );
  assert.equal(saved.state.managedCoreWallet.walletScriptPubKeyHex, state.funding.scriptPubKeyHex);
});

test("repairManagedBitcoindStage recreates the managed Core replica when verification is not ready", async (t) => {
  const state = createDerivedWalletState({
    proofStatus: "ready",
  });
  const fixture = await createWalletLifecycleFixture(t, { state });
  const servicePaths = resolveManagedServicePaths(fixture.dataDir, state.walletRootId);
  const harness = createManagedCoreRpcHarness({
    mnemonic: state.mnemonic.phrase,
    loadedWallets: [state.managedCoreWallet.walletName],
  });
  const originalListDescriptors = harness.rpc.listDescriptors;
  let listDescriptorCalls = 0;
  harness.rpc.listDescriptors = async () => {
    listDescriptorCalls += 1;

    if (listDescriptorCalls === 1) {
      return {
        descriptors: [],
      };
    }

    return await originalListDescriptors();
  };
  const attachService = async (...args: Parameters<NonNullable<typeof harness.dependencies.attachService>>) => {
    const handle = await harness.dependencies.attachService!(...args);
    return {
      ...handle,
      refreshServiceStatus: async () => ({ state: "ready" }),
    } as any;
  };
  const context = resolveWalletRepairContext({
    dataDir: fixture.dataDir,
    databasePath: fixture.databasePath,
    provider: fixture.provider,
    paths: fixture.paths,
    nowUnixMs: 123,
    probeBitcoindService: async () => ({
      compatibility: "unreachable",
      status: null,
      error: null,
    }) as any,
    attachService,
    rpcFactory: harness.dependencies.rpcFactory,
  });

  const result = await repairManagedBitcoindStage({
    context,
    servicePaths,
    state,
    recoveredFromBackup: false,
    repairStateNeedsPersist: false,
  });

  assert.equal(result.recreatedManagedCoreWallet, true);
  assert.equal(result.managedCoreReplicaAction, "recreated");
  assert.equal(result.state.managedCoreWallet.proofStatus, "ready");
  assert.equal(result.bitcoindPostRepairHealth, "ready");
});
