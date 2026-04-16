import {
  getLock,
  getBalance,
  getListing,
  getReputation,
  listActiveLocksByDomain,
  listDomainsByOwner,
  listFields,
  lookupDomain,
  resolveCanonical,
} from "@cogcoin/indexer/queries";

import type { IndexerState } from "@cogcoin/indexer/types";

import type {
  WalletDomainDetailsView,
  WalletDomainView,
  WalletFieldView,
  WalletIdentityView,
  WalletLockView,
  WalletReadContext,
  WalletReadModel,
  WalletSnapshotView,
} from "./types.js";
import type { WalletStateV1 } from "../types.js";

function bytesToHex(value: Uint8Array | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return Buffer.from(value).toString("hex");
}

function scriptHexToBytes(scriptPubKeyHex: string): Uint8Array {
  return new Uint8Array(Buffer.from(scriptPubKeyHex, "hex"));
}

function tryDecodeUtf8(value: Uint8Array | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  try {
    return new TextDecoder("utf8", { fatal: true }).decode(value);
  } catch {
    return null;
  }
}

export function createWalletReadModel(
  walletState: WalletStateV1,
  snapshot: WalletSnapshotView | null,
): WalletReadModel {
  const snapshotState = snapshot?.state ?? null;
  const localScriptHexes = new Set([
    walletState.funding.scriptPubKeyHex,
    ...(walletState.localScriptPubKeyHexes ?? []),
  ]);
  const fundingScriptBytes = scriptHexToBytes(walletState.funding.scriptPubKeyHex);
  const ownedDomains = snapshotState === null
    ? []
    : listDomainsByOwner(snapshotState, fundingScriptBytes).sort((left, right) => left.name.localeCompare(right.name));
  const anchoredOwnedDomains = ownedDomains.filter((domain) => domain.anchored);
  const canonicalDomainId = snapshotState === null ? null : resolveCanonical(snapshotState, fundingScriptBytes);
  const canonicalDomainName = canonicalDomainId === null || snapshotState === null
    ? null
    : lookupDomainById(snapshotState, canonicalDomainId)?.name ?? null;
  const observedCogBalance = snapshotState === null ? null : getBalance(snapshotState, fundingScriptBytes);
  const fundingIdentity: WalletIdentityView = {
    index: 0,
    scriptPubKeyHex: walletState.funding.scriptPubKeyHex,
    address: walletState.funding.address,
    selectors: [],
    assignedDomainNames: (walletState.domains ?? [])
      .filter((domain) => domain.currentOwnerScriptPubKeyHex === walletState.funding.scriptPubKeyHex)
      .map((domain) => domain.name)
      .sort((left, right) => left.localeCompare(right)),
    localStatus: "funding",
    effectiveStatus: "funding",
    canonicalDomainId,
    canonicalDomainName,
    ownedDomainNames: ownedDomains.map((domain) => domain.name),
    anchoredOwnedDomainNames: anchoredOwnedDomains.map((domain) => domain.name),
    observedCogBalance,
    readOnly: false,
  };

  const domainNames = new Set<string>();
  for (const domain of walletState.domains) {
    domainNames.add(domain.name);
  }
  for (const name of ownedDomains.map((domain) => domain.name)) {
    domainNames.add(name);
  }

  const domains = [...domainNames]
    .sort((left, right) => left.localeCompare(right))
    .map((name): WalletDomainView => {
      const localRecord = walletState.domains.find((domain) => domain.name === name) ?? null;
      const chainRecord = snapshotState === null ? null : lookupDomain(snapshotState, name);
      const ownerScriptPubKeyHex = chainRecord ? bytesToHex(chainRecord.ownerScriptPubKey) : localRecord?.currentOwnerScriptPubKeyHex ?? null;
      const ownerIsLocal = ownerScriptPubKeyHex !== null && localScriptHexes.has(ownerScriptPubKeyHex);
      const fields = chainRecord && snapshotState ? listFields(snapshotState, chainRecord.domainId) : null;
      const listing = chainRecord && snapshotState ? getListing(snapshotState, chainRecord.domainId) : null;
      const activeLocks = chainRecord && snapshotState ? listActiveLocksByDomain(snapshotState, chainRecord.domainId) : null;
      const reputation = chainRecord && snapshotState ? getReputation(snapshotState, chainRecord.domainId) : null;

      let localRelationship: WalletDomainView["localRelationship"] = "external";
      if (ownerIsLocal) {
        localRelationship = "local";
      } else if (ownerScriptPubKeyHex === null) {
        localRelationship = "unknown";
      }

      return {
        name,
        domainId: chainRecord?.domainId ?? localRecord?.domainId ?? null,
        anchored: chainRecord?.anchored ?? (localRecord?.canonicalChainStatus === "anchored" ? true : localRecord?.canonicalChainStatus === "registered-unanchored" ? false : null),
        ownerScriptPubKeyHex,
        ownerLocalIndex: ownerIsLocal ? 0 : null,
        ownerAddress: ownerIsLocal ? walletState.funding.address : null,
        localTracked: localRecord !== null,
        localRecord,
        chainFound: chainRecord !== null,
        chainStatus: chainRecord === null
          ? localRecord?.canonicalChainStatus ?? "unknown"
          : chainRecord.anchored ? "anchored" : "registered-unanchored",
        localAnchorIntent: null,
        foundingMessageText: chainRecord?.foundingMessage ?? localRecord?.foundingMessageText ?? null,
        endpointText: tryDecodeUtf8(chainRecord?.endpoint),
        delegateScriptPubKeyHex: bytesToHex(chainRecord?.delegate),
        minerScriptPubKeyHex: bytesToHex(chainRecord?.miner),
        fieldCount: fields?.length ?? null,
        listingPriceCogtoshi: listing?.priceCogtoshi ?? null,
        activeLockCount: activeLocks?.length ?? null,
        selfStakeCogtoshi: reputation?.selfStake ?? null,
        supportedStakeCogtoshi: reputation?.supportedStake ?? null,
        totalSupportedCogtoshi: reputation?.totalSupported ?? null,
        totalRevokedCogtoshi: reputation?.totalRevoked ?? null,
        readOnly: false,
        localRelationship,
      };
    });

  return {
    walletRootId: walletState.walletRootId,
    walletAddress: walletState.funding.address,
    walletScriptPubKeyHex: walletState.funding.scriptPubKeyHex,
    fundingIdentity,
    identities: [fundingIdentity],
    domains,
    readOnlyIdentityCount: 0,
  };
}

function lookupDomainById(state: IndexerState, domainId: number): { name: string } | null {
  for (const record of state.consensus.domainsById.values()) {
    if (record.domainId === domainId) {
      return { name: record.name };
    }
  }

  return null;
}

export function listWalletLocks(context: WalletReadContext): WalletLockView[] | null {
  if (context.snapshot === null || context.model === null) {
    return null;
  }

  const localDomainIds = new Set(
    context.model.domains
      .map((domain) => domain.domainId)
      .filter((domainId): domainId is number => domainId !== null),
  );
  const currentHeight = context.snapshot.state.history.currentHeight;
  const domainsById = new Map(
    context.model.domains
      .map((domain) => domain.domainId === null ? null : [domain.domainId, domain.name] as const)
      .filter((entry): entry is readonly [number, string] => entry !== null),
  );
  const locks = [...context.snapshot.state.consensus.locks.values()]
    .filter((lock) => {
      const lockerHex = bytesToHex(lock.lockerScriptPubKey);
      return (lockerHex !== null && lockerHex === context.model!.walletScriptPubKeyHex) || localDomainIds.has(lock.recipientDomainId);
    })
    .sort((left, right) => left.timeoutHeight - right.timeoutHeight || left.lockId - right.lockId);

  return locks.map((lock) => {
    const lockerScriptPubKeyHex = bytesToHex(lock.lockerScriptPubKey);
    const recipientDomain = context.snapshot!.state.consensus.domainsById.get(lock.recipientDomainId) ?? null;
    const recipientOwnerHex = recipientDomain === null ? null : bytesToHex(recipientDomain.ownerScriptPubKey);
    const claimableNow = currentHeight !== null
      && currentHeight < lock.timeoutHeight
      && recipientOwnerHex !== null
      && recipientOwnerHex === context.model!.walletScriptPubKeyHex;

    return {
      lockId: lock.lockId,
      status: "active",
      amountCogtoshi: lock.amount,
      timeoutHeight: lock.timeoutHeight,
      lockerScriptPubKeyHex: lockerScriptPubKeyHex ?? "",
      lockerLocal: lockerScriptPubKeyHex === context.model!.walletScriptPubKeyHex,
      lockerLocalIndex: lockerScriptPubKeyHex === context.model!.walletScriptPubKeyHex ? 0 : null,
      recipientDomainId: lock.recipientDomainId,
      recipientDomainName: domainsById.get(lock.recipientDomainId) ?? null,
      recipientLocal: localDomainIds.has(lock.recipientDomainId),
      claimableNow,
      reclaimableNow: currentHeight !== null
        && currentHeight >= lock.timeoutHeight
        && lockerScriptPubKeyHex === context.model!.walletScriptPubKeyHex,
    };
  });
}

export function findWalletLock(context: WalletReadContext, lockId: number): ReturnType<typeof getLock> {
  if (context.snapshot === null) {
    return null;
  }

  return getLock(context.snapshot.state, lockId);
}

export function findWalletDomain(context: WalletReadContext, name: string): WalletDomainDetailsView | null {
  const domain = context.model?.domains.find((entry) => entry.name === name)
    ?? (context.snapshot
      ? (() => {
        const chainDomain = lookupDomain(context.snapshot.state, name);
        if (chainDomain === null) {
          return null;
        }

        return {
          name: chainDomain.name,
          domainId: chainDomain.domainId,
          anchored: chainDomain.anchored,
          ownerScriptPubKeyHex: bytesToHex(chainDomain.ownerScriptPubKey),
          ownerLocalIndex: null,
          ownerAddress: null,
          localTracked: false,
          localRecord: null,
          chainFound: true,
          chainStatus: chainDomain.anchored ? "anchored" : "registered-unanchored",
          localAnchorIntent: null,
          foundingMessageText: chainDomain.foundingMessage,
          endpointText: tryDecodeUtf8(chainDomain.endpoint),
          delegateScriptPubKeyHex: bytesToHex(chainDomain.delegate),
          minerScriptPubKeyHex: bytesToHex(chainDomain.miner),
          fieldCount: listFields(context.snapshot.state, chainDomain.domainId).length,
          listingPriceCogtoshi: getListing(context.snapshot.state, chainDomain.domainId)?.priceCogtoshi ?? null,
          activeLockCount: listActiveLocksByDomain(context.snapshot.state, chainDomain.domainId).length,
          selfStakeCogtoshi: getReputation(context.snapshot.state, chainDomain.domainId)?.selfStake ?? null,
          supportedStakeCogtoshi: getReputation(context.snapshot.state, chainDomain.domainId)?.supportedStake ?? null,
          totalSupportedCogtoshi: getReputation(context.snapshot.state, chainDomain.domainId)?.totalSupported ?? null,
          totalRevokedCogtoshi: getReputation(context.snapshot.state, chainDomain.domainId)?.totalRevoked ?? null,
          readOnly: false,
          localRelationship: "external" as const,
        };
      })()
      : null);

  if (domain === null) {
    return null;
  }

  return {
    domain,
    localRelationship: domain.localRelationship,
  };
}

export function listDomainFields(context: WalletReadContext, name: string): WalletFieldView[] | null {
  if (context.snapshot === null) {
    return null;
  }

  const domain = lookupDomain(context.snapshot.state, name);

  if (domain === null) {
    return null;
  }

  return listFields(context.snapshot.state, domain.domainId)
    .slice()
    .sort((left, right) => left.fieldId - right.fieldId)
    .map((field) => {
      const value = readDomainDataByName(context.snapshot!.state, domain.domainId, field.name);
      return {
        domainName: name,
        domainId: domain.domainId,
        fieldId: field.fieldId,
        name: field.name,
        permanent: field.permanent,
        hasValue: value !== null,
        format: value?.format ?? null,
        preview: value === null ? null : createFieldPreview(value.value, value.format),
        rawValueHex: value === null ? null : Buffer.from(value.value).toString("hex"),
      };
    });
}

export function findDomainField(context: WalletReadContext, domainName: string, fieldName: string): WalletFieldView | null {
  return listDomainFields(context, domainName)?.find((field) => field.name === fieldName) ?? null;
}

export function createFieldPreview(value: Uint8Array, format: number): string {
  if (value.length === 0) {
    return "(empty)";
  }

  const decoded = tryDecodeUtf8(value);

  if ((format === 0x02 || format === 0x09) && decoded !== null) {
    return decoded.length <= 80 ? decoded : `${decoded.slice(0, 77)}...`;
  }

  const hex = Buffer.from(value).toString("hex");
  return hex.length <= 64 ? `hex:${hex}` : `hex:${hex.slice(0, 61)}...`;
}

export function formatFieldFormat(format: number | null): string {
  if (format === null) {
    return "none";
  }

  if (format === 0x00) {
    return "clear (0x00)";
  }

  if (format === 0x01) {
    return "bytes (0x01)";
  }

  if (format === 0x02) {
    return "text (0x02)";
  }

  if (format === 0x09) {
    return "json (0x09)";
  }

  return `raw (0x${format.toString(16).padStart(2, "0")})`;
}

function readDomainDataByName(
  state: IndexerState,
  domainId: number,
  fieldName: string,
): { format: number; value: Uint8Array } | null {
  const key = `${domainId}:${fieldName}`;
  const fieldId = state.consensus.fieldIdsByName.get(key);

  if (fieldId === undefined) {
    return null;
  }

  return state.consensus.domainData.get(`${domainId}:${fieldId}`) ?? null;
}
