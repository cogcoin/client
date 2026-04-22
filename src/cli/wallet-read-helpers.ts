import {
  listDomainFields,
  listWalletLocks,
} from "../wallet/read/index.js";
import type {
  WalletFieldView,
  WalletLockView,
  WalletReadContext,
} from "../wallet/read/index.js";

export function listVisibleWalletLocks(
  context: WalletReadContext,
  options: {
    claimableOnly: boolean;
    reclaimableOnly: boolean;
  },
): WalletLockView[] | null {
  const locks = listWalletLocks(context);

  if (locks === null) {
    return null;
  }

  if (options.claimableOnly) {
    return locks.filter((lock) => lock.claimableNow);
  }

  if (options.reclaimableOnly) {
    return locks.filter((lock) => lock.reclaimableNow);
  }

  return locks;
}

export function listVisibleDomainFields(
  context: WalletReadContext,
  domainName: string,
): WalletFieldView[] | null {
  return listDomainFields(context, domainName);
}
