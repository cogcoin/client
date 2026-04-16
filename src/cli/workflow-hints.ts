import type {
  WalletIdentityView,
  WalletLockView,
  WalletReadContext,
} from "../wallet/read/index.js";

function isRootDomainName(domainName: string): boolean {
  return !domainName.includes("-");
}

export function formatNextStepLines(nextSteps: readonly string[]): string[] {
  return nextSteps.map((step) => `Next step: ${step}`);
}

export function getFundingQuickstartGuidance(): string {
  return "Fund this wallet with about 0.0015 BTC so you can buy a 6+ character domain to start mining and still keep BTC available for mining transaction fees.";
}

export function getInitNextSteps(): string[] {
  return ["cogcoin sync", "cogcoin address"];
}

export function getRestoreNextSteps(): string[] {
  return ["cogcoin sync", "cogcoin address"];
}

function blocksSyncBootstrap(
  context: Pick<WalletReadContext, "bitcoind" | "indexer">,
): boolean {
  return context.bitcoind.health === "service-version-mismatch"
    || context.bitcoind.health === "wallet-root-mismatch"
    || context.bitcoind.health === "runtime-mismatch"
    || context.bitcoind.health === "replica-missing"
    || context.bitcoind.health === "replica-mismatch"
    || context.bitcoind.health === "failed"
    || context.indexer.health === "schema-mismatch"
    || context.indexer.health === "service-version-mismatch"
    || context.indexer.health === "wallet-root-mismatch"
    || context.indexer.health === "failed";
}

export function getBootstrapSyncNextStep(
  context: Pick<WalletReadContext, "bitcoind" | "indexer" | "nodeHealth">,
): string | null {
  if (blocksSyncBootstrap(context)) {
    return null;
  }

  return context.bitcoind.health !== "ready"
    || context.indexer.health !== "synced"
    || context.nodeHealth !== "synced"
    ? "cogcoin sync"
    : null;
}

export function getRegisterNextSteps(
  domainName: string,
  registerKind: "root" | "subdomain",
): string[] {
  return registerKind === "root"
    ? [
      `cogcoin show ${domainName}`,
      `cogcoin anchor ${domainName} once it confirms`,
    ]
    : [`cogcoin show ${domainName}`];
}

export function getAnchorNextSteps(domainName: string): string[] {
  const nextSteps = [`cogcoin show ${domainName}`];

  if (isRootDomainName(domainName)) {
    nextSteps.push("cogcoin mine", "cogcoin mine start");
  }

  return nextSteps;
}

export function getHooksEnableMiningNextSteps(): string[] {
  return ["cogcoin mine", "cogcoin mine start"];
}

export function getMineSetupNextSteps(): string[] {
  return ["cogcoin mine", "cogcoin mine start"];
}

export function getMineStopNextSteps(): string[] {
  return ["cogcoin mine log"];
}

export function getAddressNextSteps(
  context: Pick<WalletReadContext, "bitcoind" | "indexer" | "nodeHealth">,
  address: string | null | undefined,
): string[] {
  if (address === null || address === undefined || address.length === 0) {
    return [];
  }

  const nextSteps: string[] = [];
  const bootstrapSync = getBootstrapSyncNextStep(context);
  if (bootstrapSync !== null) {
    nextSteps.push(bootstrapSync);
  }
  nextSteps.push("fund this wallet, then run cogcoin status");
  return nextSteps;
}

export function getIdsNextSteps(
  identities: readonly WalletIdentityView[] | null | undefined,
): string[] {
  return identities === null || identities === undefined || identities.length === 0
    ? []
    : [
      "cogcoin register <root>",
      "cogcoin send ...",
      "cogcoin cog lock ...",
    ];
}

export function getLocksNextSteps(
  locks: readonly WalletLockView[] | null | undefined,
): string[] {
  if (locks === null || locks === undefined || locks.length === 0) {
    return [];
  }

  const nextSteps: string[] = [];
  const claimable = locks.find((lock) => lock.claimableNow);
  const reclaimable = locks.find((lock) => lock.reclaimableNow);

  if (claimable !== undefined) {
    nextSteps.push(`cogcoin claim ${claimable.lockId} --preimage <32-byte-hex>`);
  }

  if (reclaimable !== undefined) {
    nextSteps.push(`cogcoin reclaim ${reclaimable.lockId}`);
  }

  return nextSteps;
}
