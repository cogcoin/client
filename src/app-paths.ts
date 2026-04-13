import { homedir } from "node:os";
import { dirname, isAbsolute, join, win32 as win32Path } from "node:path";

export interface CogcoinPathResolution {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

export interface CogcoinResolvedPaths {
  dataRoot: string;
  configRoot: string;
  stateRoot: string;
  runtimeRoot: string;
  hooksRoot: string;
  bitcoinDataDir: string;
  clientDataDir: string;
  clientDatabasePath: string;
  indexerRoot: string;
  clientConfigPath: string;
  walletStateDirectory: string;
  walletStatePath: string;
  walletStateBackupPath: string;
  walletUnlockSessionPath: string;
  walletExplicitLockPath: string;
  walletControlLockPath: string;
  bitcoindLockPath: string;
  bitcoindStatusPath: string;
  indexerDaemonLockPath: string;
  indexerStatusPath: string;
  hooksMiningDir: string;
  hooksMiningEntrypointPath: string;
  hooksMiningPackageJsonPath: string;
  miningRoot: string;
  miningStatusPath: string;
  miningEventsPath: string;
  miningControlLockPath: string;
}

function resolveLocalAppDataWindows(
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
): string {
  return env.LOCALAPPDATA ?? win32Path.join(homeDirectory, "AppData", "Local");
}

function joinForPlatform(
  platform: NodeJS.Platform,
  ...parts: string[]
): string {
  return platform === "win32" ? win32Path.join(...parts) : join(...parts);
}

function resolveAbsoluteEnvPath(
  value: string | undefined,
  fallbackPath: string,
): string {
  return value && isAbsolute(value) ? value : fallbackPath;
}

function resolveLinuxRoots(
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
): Pick<CogcoinResolvedPaths, "dataRoot" | "configRoot" | "stateRoot" | "runtimeRoot" | "hooksRoot"> {
  const dataRoot = join(
    resolveAbsoluteEnvPath(env.XDG_DATA_HOME, join(homeDirectory, ".local", "share")),
    "cogcoin",
  );
  const configRoot = join(
    resolveAbsoluteEnvPath(env.XDG_CONFIG_HOME, join(homeDirectory, ".config")),
    "cogcoin",
  );
  const stateRoot = join(
    resolveAbsoluteEnvPath(env.XDG_STATE_HOME, join(homeDirectory, ".local", "state")),
    "cogcoin",
  );
  const runtimeRoot = env.XDG_RUNTIME_DIR && isAbsolute(env.XDG_RUNTIME_DIR)
    ? join(env.XDG_RUNTIME_DIR, "cogcoin")
    : join(stateRoot, "runtime");

  return {
    dataRoot,
    configRoot,
    stateRoot,
    runtimeRoot,
    hooksRoot: join(configRoot, "hooks"),
  };
}

export function resolveCogcoinPathsForTesting(
  resolution: CogcoinPathResolution = {},
): CogcoinResolvedPaths {
  const platform = resolution.platform ?? process.platform;
  const env = resolution.env ?? process.env;
  const homeDirectory = resolution.homeDirectory ?? homedir();

  let dataRoot: string;
  let configRoot: string;
  let stateRoot: string;
  let runtimeRoot: string;
  let hooksRoot: string;

  if (platform === "darwin") {
    dataRoot = join(homeDirectory, "Library", "Application Support", "Cogcoin");
    configRoot = join(dataRoot, "config");
    stateRoot = join(dataRoot, "state");
    runtimeRoot = join(dataRoot, "runtime");
    hooksRoot = join(dataRoot, "hooks");
  } else if (platform === "win32") {
    dataRoot = win32Path.join(resolveLocalAppDataWindows(env, homeDirectory), "Cogcoin");
    configRoot = win32Path.join(dataRoot, "config");
    stateRoot = win32Path.join(dataRoot, "state");
    runtimeRoot = win32Path.join(dataRoot, "runtime");
    hooksRoot = win32Path.join(dataRoot, "hooks");
  } else {
    const linuxRoots = resolveLinuxRoots(env, homeDirectory);
    dataRoot = linuxRoots.dataRoot;
    configRoot = linuxRoots.configRoot;
    stateRoot = linuxRoots.stateRoot;
    runtimeRoot = linuxRoots.runtimeRoot;
    hooksRoot = linuxRoots.hooksRoot;
  }

  const bitcoinDataDir = joinForPlatform(platform, dataRoot, "bitcoin");
  const clientDataDir = joinForPlatform(platform, dataRoot, "client");
  const clientDatabasePath = joinForPlatform(platform, clientDataDir, "client.sqlite");
  const indexerRoot = joinForPlatform(platform, dataRoot, "indexer");
  const clientConfigPath = joinForPlatform(platform, configRoot, "client-config.json");
  const walletStateDirectory = stateRoot;
  const walletStatePath = joinForPlatform(platform, walletStateDirectory, "wallet-state.enc");
  const walletStateBackupPath = joinForPlatform(platform, walletStateDirectory, "wallet-state.enc.bak");
  const walletUnlockSessionPath = joinForPlatform(platform, runtimeRoot, "wallet-unlock-session.enc");
  const walletExplicitLockPath = joinForPlatform(platform, runtimeRoot, "wallet-explicit-lock.json");
  const walletControlLockPath = joinForPlatform(platform, runtimeRoot, "wallet-control.lock");
  const bitcoindLockPath = joinForPlatform(platform, runtimeRoot, "bitcoind.lock");
  const bitcoindStatusPath = joinForPlatform(platform, runtimeRoot, "bitcoind-status.json");
  const indexerDaemonLockPath = joinForPlatform(platform, runtimeRoot, "indexer-daemon.lock");
  const indexerStatusPath = joinForPlatform(platform, indexerRoot, "status.json");
  const hooksMiningDir = joinForPlatform(platform, hooksRoot, "mining");
  const hooksMiningEntrypointPath = joinForPlatform(platform, hooksMiningDir, "generate-sentences.js");
  const hooksMiningPackageJsonPath = joinForPlatform(platform, hooksMiningDir, "package.json");
  const miningRoot = joinForPlatform(platform, runtimeRoot, "mining");
  const miningStatusPath = joinForPlatform(platform, miningRoot, "status.json");
  const miningEventsPath = joinForPlatform(platform, miningRoot, "events.jsonl");
  const miningControlLockPath = joinForPlatform(platform, runtimeRoot, "mining-control.lock");

  return {
    dataRoot,
    configRoot,
    stateRoot,
    runtimeRoot,
    hooksRoot,
    bitcoinDataDir,
    clientDataDir,
    clientDatabasePath,
    indexerRoot,
    clientConfigPath,
    walletStateDirectory,
    walletStatePath,
    walletStateBackupPath,
    walletUnlockSessionPath,
    walletExplicitLockPath,
    walletControlLockPath,
    bitcoindLockPath,
    bitcoindStatusPath,
    indexerDaemonLockPath,
    indexerStatusPath,
    hooksMiningDir,
    hooksMiningEntrypointPath,
    hooksMiningPackageJsonPath,
    miningRoot,
    miningStatusPath,
    miningEventsPath,
    miningControlLockPath,
  };
}

export function resolveCogcoinAppRootForTesting(
  resolution: CogcoinPathResolution = {},
): string {
  return resolveCogcoinPathsForTesting(resolution).dataRoot;
}

export function resolveDefaultBitcoindDataDirForTesting(
  resolution: CogcoinPathResolution = {},
): string {
  return resolveCogcoinPathsForTesting(resolution).bitcoinDataDir;
}

export function resolveDefaultClientDatabasePathForTesting(
  resolution: CogcoinPathResolution = {},
): string {
  return resolveCogcoinPathsForTesting(resolution).clientDatabasePath;
}

export function resolveDefaultClientDatabaseDirectoryForTesting(
  resolution: CogcoinPathResolution = {},
): string {
  const platform = resolution.platform ?? process.platform;
  const dbPath = resolveDefaultClientDatabasePathForTesting(resolution);
  return platform === "win32" ? win32Path.dirname(dbPath) : dirname(dbPath);
}
