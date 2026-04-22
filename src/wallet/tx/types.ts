import type {
  RpcDecodedPsbt,
  RpcEstimateSmartFeeResult,
  RpcFinalizePsbtResult,
  RpcListUnspentEntry,
  RpcLockedUnspent,
  RpcMempoolEntry,
  RpcTestMempoolAcceptResult,
  RpcTransaction,
  RpcWalletTransaction,
  RpcWalletCreateFundedPsbtResult,
  RpcWalletProcessPsbtResult,
} from "../../bitcoind/types.js";
import type {
  OutpointRecord,
  WalletStateV1,
} from "../types.js";

export interface MutationSender {
  localIndex: number;
  scriptPubKeyHex: string;
  address: string;
}

export interface WalletMutationRpcClient {
  listUnspent(walletName: string, minConf?: number): Promise<RpcListUnspentEntry[]>;
  listLockUnspent?(walletName: string): Promise<RpcLockedUnspent[]>;
  lockUnspent?(walletName: string, unlock: boolean, outputs: RpcLockedUnspent[]): Promise<boolean>;
  getTransaction?(walletName: string, txid: string): Promise<RpcWalletTransaction>;
  getRawTransaction?(txid: string, verbose?: boolean): Promise<RpcTransaction>;
  getMempoolEntry?(txid: string): Promise<RpcMempoolEntry>;
  estimateSmartFee?(
    confirmTarget: number,
    mode: "conservative" | "economical",
  ): Promise<RpcEstimateSmartFeeResult>;
  walletCreateFundedPsbt(
    walletName: string,
    inputs: Array<{ txid: string; vout: number }>,
    outputs: unknown[],
    locktime: number,
    options: Record<string, unknown>,
    bip32Derivs?: boolean,
  ): Promise<RpcWalletCreateFundedPsbtResult>;
  decodePsbt(psbt: string): Promise<RpcDecodedPsbt>;
  walletPassphrase(walletName: string, passphrase: string, timeoutSeconds: number): Promise<null>;
  walletProcessPsbt(
    walletName: string,
    psbt: string,
    sign?: boolean,
    sighashType?: string,
  ): Promise<RpcWalletProcessPsbtResult>;
  walletLock(walletName: string): Promise<null>;
  finalizePsbt(psbt: string, extract?: boolean): Promise<RpcFinalizePsbtResult>;
  decodeRawTransaction(hex: string): Promise<RpcTransaction>;
  testMempoolAccept(rawTransactions: string[]): Promise<RpcTestMempoolAcceptResult[]>;
}

export interface BuiltWalletMutationTransaction {
  funded: RpcWalletCreateFundedPsbtResult;
  decoded: RpcDecodedPsbt;
  psbt: string;
  rawHex: string;
  txid: string;
  wtxid: string | null;
  temporaryBuilderLockedOutpoints: OutpointRecord[];
}

export interface FixedWalletInput extends OutpointRecord {}

export type WalletMutationReadyReadState = {
  localState: {
    availability: "ready";
    state: WalletStateV1;
  };
};
