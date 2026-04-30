import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFile } from "node:fs/promises";

import type {
  RpcBlock,
  RpcBlockchainInfo,
  RpcChainStatesResponse,
  RpcCreateWalletResult,
  RpcDecodedPsbt,
  RpcDescriptorInfo,
  RpcEstimateSmartFeeResult,
  RpcFinalizePsbtResult,
  RpcImportDescriptorRequest,
  RpcImportDescriptorResult,
  RpcListUnspentEntry,
  RpcMempoolEntry,
  RpcMempoolInfo,
  RpcRawMempoolVerbose,
  RpcRawMempoolEntries,
  RpcListDescriptorsResult,
  RpcLockedUnspent,
  RpcLoadTxOutSetResult,
  RpcLoadWalletResult,
  RpcNetworkInfo,
  RpcTestMempoolAcceptResult,
  RpcWalletInfo,
  RpcWalletCreateFundedPsbtResult,
  RpcWalletProcessPsbtResult,
  RpcTransaction,
  RpcWalletTransaction,
  RpcZmqNotification,
} from "./types.js";

interface RpcEnvelope<T> {
  result: T;
  error: { code: number; message: string } | null;
}

interface RpcRequestPayload {
  readonly body: string;
  readonly headers: Record<string, string>;
}

interface RpcResponsePayload {
  readonly statusCode: number;
  readonly bodyText: string;
}

export interface RpcTransportOptions {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  abortSignal?: AbortSignal;
  requestImpl?: (request: {
    url: URL;
    payload: RpcRequestPayload;
  }) => Promise<RpcResponsePayload>;
}

const DEFAULT_MANAGED_RPC_REQUEST_TIMEOUT_MS = 30_000;

export class BitcoinRpcClient {
  readonly #url: string;
  readonly #cookieFile: string;
  readonly #fetchImpl: typeof fetch;
  readonly #requestTimeoutMs: number;
  readonly #abortSignal: AbortSignal | undefined;
  readonly #requestImpl: (request: {
    url: URL;
    payload: RpcRequestPayload;
  }) => Promise<RpcResponsePayload>;

  constructor(url: string, cookieFile: string, options: RpcTransportOptions = {}) {
    this.#url = url;
    this.#cookieFile = cookieFile;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_MANAGED_RPC_REQUEST_TIMEOUT_MS;
    this.#abortSignal = options.abortSignal;
    this.#requestImpl = options.requestImpl ?? this.#sendNodeRequest.bind(this);
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    return this.#callAtUrl<T>(this.#url, method, params);
  }

  async callWallet<T>(walletName: string, method: string, params: unknown[] = []): Promise<T> {
    const url = new URL(this.#url);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/wallet/${encodeURIComponent(walletName)}`;
    return this.#callAtUrl<T>(url.toString(), method, params);
  }

  async #callAtUrl<T>(urlString: string, method: string, params: unknown[] = []): Promise<T> {
    const payload = await this.#buildRequestPayload(method, params);
    let response: Response;
    const requestSignal = this.#createRequestSignal();

    try {
      response = await this.#fetchImpl(urlString, {
        method: "POST",
        headers: payload.headers,
        body: payload.body,
        signal: requestSignal.signal,
      });
    } catch (error) {
      if (this.#abortSignal?.aborted) {
        const reason = this.#abortSignal.reason;
        if (reason instanceof Error) {
          throw reason;
        }
      }
      throw new Error(this.#describeTransportError(urlString, method, error), { cause: error });
    } finally {
      requestSignal.dispose();
    }

    return this.#parseResponse(method, response.status, await response.text());
  }

  #createRequestSignal(): {
    signal: AbortSignal;
    dispose(): void;
  } {
    const timeoutSignal = AbortSignal.timeout(this.#requestTimeoutMs);

    if (this.#abortSignal === undefined) {
      return {
        signal: timeoutSignal,
        dispose() {},
      };
    }

    const controller = new AbortController();
    const handleAbort = (source: AbortSignal) => {
      controller.abort(source.reason);
    };
    const forwardTimeout = () => {
      handleAbort(timeoutSignal);
    };
    const forwardAbort = () => {
      handleAbort(this.#abortSignal!);
    };

    if (timeoutSignal.aborted) {
      handleAbort(timeoutSignal);
    } else {
      timeoutSignal.addEventListener("abort", forwardTimeout, { once: true });
    }

    if (this.#abortSignal.aborted) {
      handleAbort(this.#abortSignal);
    } else {
      this.#abortSignal.addEventListener("abort", forwardAbort, { once: true });
    }

    return {
      signal: controller.signal,
      dispose: () => {
        timeoutSignal.removeEventListener("abort", forwardTimeout);
        this.#abortSignal?.removeEventListener("abort", forwardAbort);
      },
    };
  }

  async #buildRequestPayload(method: string, params: unknown[]): Promise<RpcRequestPayload> {
    let cookie: string;

    try {
      cookie = (await readFile(this.#cookieFile, "utf8")).trim();
    } catch (error) {
      throw new Error(this.#describeCookieReadError(method, error), { cause: error });
    }

    return {
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(cookie).toString("base64")}`,
      },
      body: JSON.stringify({
        jsonrpc: "1.0",
        id: method,
        method,
        params,
      }),
    };
  }

  #parseResponse<T>(method: string, statusCode: number, bodyText: string): T {
    let payload: RpcEnvelope<T> | null = null;

    try {
      payload = JSON.parse(bodyText) as RpcEnvelope<T>;
    } catch (error) {
      if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`bitcoind_rpc_http_${statusCode}`);
      }

      throw new Error(this.#describeInvalidResponseError(method), { cause: error });
    }

    if (payload?.error) {
      throw new Error(`bitcoind_rpc_${method}_${payload.error.code}_${payload.error.message}`);
    }

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`bitcoind_rpc_http_${statusCode}`);
    }

    return payload.result;
  }

  #describeTransportError(urlString: string, method: string, error: unknown): string {
    const endpoint = new URL(urlString).host;
    const detail = this.#extractErrorDetail(error);

    if (detail === null) {
      return `The managed Bitcoin RPC request to ${endpoint} for ${method} failed.`;
    }

    return `The managed Bitcoin RPC request to ${endpoint} for ${method} failed: ${detail}.`;
  }

  #describeInvalidResponseError(method: string): string {
    const endpoint = new URL(this.#url).host;
    return `The managed Bitcoin RPC request to ${endpoint} for ${method} returned an invalid JSON response.`;
  }

  #describeCookieReadError(method: string, error: unknown): string {
    const detail = this.#extractErrorDetail(error);

    if (this.#isMissingFileError(error)) {
      return `The managed Bitcoin RPC cookie file is unavailable at ${this.#cookieFile} while preparing ${method}. The managed node is not running or is shutting down.`;
    }

    if (detail === null) {
      return `The managed Bitcoin RPC cookie file could not be read at ${this.#cookieFile} while preparing ${method}.`;
    }

    return `The managed Bitcoin RPC cookie file could not be read at ${this.#cookieFile} while preparing ${method}: ${detail}.`;
  }

  #extractErrorDetail(error: unknown): string | null {
    const parts: string[] = [];
    let current: unknown = error;

    while (current instanceof Error) {
      const message = current.message.trim();

      if (message.length > 0 && message !== "fetch failed" && !parts.includes(message)) {
        parts.push(message);
      }

      const next = (current as Error & { cause?: unknown }).cause;

      if (next === undefined || next === current) {
        break;
      }

      current = next;
    }

    return parts.length > 0 ? parts.join(" Caused by: ") : null;
  }

  #isMissingFileError(error: unknown): boolean {
    return error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT";
  }

  async #callWithNodeRequest<T>(method: string, params: unknown[] = []): Promise<T> {
    const url = new URL(this.#url);
    const payload = await this.#buildRequestPayload(method, params);
    let response: RpcResponsePayload;

    try {
      response = await this.#requestImpl({ url, payload });
    } catch (error) {
      throw new Error(this.#describeTransportError(this.#url, method, error), { cause: error });
    }

    return this.#parseResponse(method, response.statusCode, response.bodyText);
  }

  async #sendNodeRequest(request: {
    url: URL;
    payload: RpcRequestPayload;
  }): Promise<RpcResponsePayload> {
    const requester = request.url.protocol === "https:" ? httpsRequest : httpRequest;
    const contentLength = Buffer.byteLength(request.payload.body);

    return new Promise<RpcResponsePayload>((resolve, reject) => {
      let settled = false;
      const finish = (handler: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        handler();
      };

      const req = requester(request.url, {
        method: "POST",
        agent: false,
        headers: {
          ...request.payload.headers,
          "content-length": String(contentLength),
        },
      }, (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          finish(() => {
            resolve({
              statusCode: response.statusCode ?? 0,
              bodyText: Buffer.concat(chunks).toString("utf8"),
            });
          });
        });
        response.on("aborted", () => {
          finish(() => {
            reject(new Error("The managed Bitcoin RPC response was aborted."));
          });
        });
        response.on("error", (error) => {
          finish(() => {
            reject(error);
          });
        });
      });

      req.setTimeout(this.#requestTimeoutMs);
      req.on("socket", (socket) => {
        socket.setTimeout(this.#requestTimeoutMs);
      });
      req.on("error", (error) => {
        finish(() => {
          reject(error);
        });
      });
      req.end(request.payload.body);
    });
  }

  getBlockchainInfo(): Promise<RpcBlockchainInfo> {
    return this.call<RpcBlockchainInfo>("getblockchaininfo");
  }

  getNetworkInfo(): Promise<RpcNetworkInfo> {
    return this.call<RpcNetworkInfo>("getnetworkinfo");
  }

  getBestBlockHash(): Promise<string> {
    return this.call<string>("getbestblockhash");
  }

  getBlockHash(height: number): Promise<string> {
    return this.call<string>("getblockhash", [height]);
  }

  getBlock(hashHex: string): Promise<RpcBlock> {
    return this.call<RpcBlock>("getblock", [hashHex, 3]);
  }

  getChainStates(): Promise<RpcChainStatesResponse> {
    return this.call<RpcChainStatesResponse>("getchainstates");
  }

  loadTxOutSet(snapshotPath: string): Promise<RpcLoadTxOutSetResult> {
    return this.#callWithNodeRequest<RpcLoadTxOutSetResult>("loadtxoutset", [snapshotPath]);
  }

  getZmqNotifications(): Promise<RpcZmqNotification[]> {
    return this.call<RpcZmqNotification[]>("getzmqnotifications");
  }

  createWallet(
    walletName: string,
    options: {
      disablePrivateKeys?: boolean;
      blank?: boolean;
      passphrase?: string;
      avoidReuse?: boolean;
      descriptors?: boolean;
      loadOnStartup?: boolean;
    } = {},
  ): Promise<RpcCreateWalletResult> {
    return this.call<RpcCreateWalletResult>("createwallet", [
      walletName,
      options.disablePrivateKeys ?? false,
      options.blank ?? true,
      options.passphrase ?? "",
      options.avoidReuse ?? false,
      options.descriptors ?? true,
      options.loadOnStartup ?? true,
    ]);
  }

  loadWallet(walletName: string, loadOnStartup = true): Promise<RpcLoadWalletResult> {
    return this.call<RpcLoadWalletResult>("loadwallet", [walletName, loadOnStartup]);
  }

  unloadWallet(walletName: string, loadOnStartup = true): Promise<null> {
    return this.call<null>("unloadwallet", [walletName, loadOnStartup]);
  }

  listWallets(): Promise<string[]> {
    return this.call<string[]>("listwallets");
  }

  getDescriptorInfo(descriptor: string): Promise<RpcDescriptorInfo> {
    return this.call<RpcDescriptorInfo>("getdescriptorinfo", [descriptor]);
  }

  deriveAddresses(descriptor: string, range?: number | [number, number]): Promise<string[]> {
    const params = range === undefined ? [descriptor] : [descriptor, range];
    return this.call<string[]>("deriveaddresses", params);
  }

  listDescriptors(walletName: string, privateOnly = false): Promise<RpcListDescriptorsResult> {
    return this.callWallet<RpcListDescriptorsResult>(walletName, "listdescriptors", [privateOnly]);
  }

  importDescriptors(
    walletName: string,
    requests: RpcImportDescriptorRequest[],
  ): Promise<RpcImportDescriptorResult[]> {
    return this.callWallet<RpcImportDescriptorResult[]>(walletName, "importdescriptors", [requests]);
  }

  getWalletInfo(walletName: string): Promise<RpcWalletInfo> {
    return this.callWallet<RpcWalletInfo>(walletName, "getwalletinfo");
  }

  walletLock(walletName: string): Promise<null> {
    return this.callWallet<null>(walletName, "walletlock");
  }

  walletPassphrase(walletName: string, passphrase: string, timeoutSeconds: number): Promise<null> {
    return this.callWallet<null>(walletName, "walletpassphrase", [passphrase, timeoutSeconds]);
  }

  walletProcessPsbt(
    walletName: string,
    psbt: string,
    sign = true,
    sighashType = "DEFAULT",
  ): Promise<RpcWalletProcessPsbtResult> {
    return this.callWallet<RpcWalletProcessPsbtResult>(walletName, "walletprocesspsbt", [
      psbt,
      sign,
      sighashType,
    ]);
  }

  listUnspent(walletName: string, minConf = 1): Promise<RpcListUnspentEntry[]> {
    return this.callWallet<RpcListUnspentEntry[]>(walletName, "listunspent", [minConf]);
  }

  listLockUnspent(walletName: string): Promise<RpcLockedUnspent[]> {
    return this.callWallet<RpcLockedUnspent[]>(walletName, "listlockunspent");
  }

  lockUnspent(walletName: string, unlock: boolean, outputs: RpcLockedUnspent[]): Promise<boolean> {
    return this.callWallet<boolean>(walletName, "lockunspent", [unlock, outputs]);
  }

  walletCreateFundedPsbt(
    walletName: string,
    inputs: Array<{ txid: string; vout: number }>,
    outputs: unknown[],
    locktime: number,
    options: Record<string, unknown>,
    bip32Derivs = true,
  ): Promise<RpcWalletCreateFundedPsbtResult> {
    return this.callWallet<RpcWalletCreateFundedPsbtResult>(walletName, "walletcreatefundedpsbt", [
      inputs,
      outputs,
      locktime,
      options,
      bip32Derivs,
    ]);
  }

  decodePsbt(psbt: string): Promise<RpcDecodedPsbt> {
    return this.call<RpcDecodedPsbt>("decodepsbt", [psbt]);
  }

  finalizePsbt(psbt: string, extract = true): Promise<RpcFinalizePsbtResult> {
    return this.call<RpcFinalizePsbtResult>("finalizepsbt", [psbt, extract]);
  }

  decodeRawTransaction(hex: string): Promise<RpcTransaction> {
    return this.call<RpcTransaction>("decoderawtransaction", [hex]);
  }

  testMempoolAccept(rawTransactions: string[]): Promise<RpcTestMempoolAcceptResult[]> {
    return this.call<RpcTestMempoolAcceptResult[]>("testmempoolaccept", [rawTransactions]);
  }

  sendRawTransaction(hex: string): Promise<string> {
    return this.call<string>("sendrawtransaction", [hex]);
  }

  getRawMempool(): Promise<string[]> {
    return this.call<string[]>("getrawmempool");
  }

  getRawMempoolVerbose(): Promise<RpcRawMempoolVerbose> {
    return this.call<RpcRawMempoolVerbose>("getrawmempool", [false, true]);
  }

  getRawMempoolEntries(): Promise<RpcRawMempoolEntries> {
    return this.call<RpcRawMempoolEntries>("getrawmempool", [true]);
  }

  getMempoolInfo(): Promise<RpcMempoolInfo> {
    return this.call<RpcMempoolInfo>("getmempoolinfo");
  }

  getMempoolEntry(txid: string): Promise<RpcMempoolEntry> {
    return this.call<RpcMempoolEntry>("getmempoolentry", [txid]);
  }

  estimateSmartFee(
    confirmTarget: number,
    mode: "conservative" | "economical",
  ): Promise<RpcEstimateSmartFeeResult> {
    return this.call<RpcEstimateSmartFeeResult>("estimatesmartfee", [confirmTarget, mode]);
  }

  saveMempool(): Promise<null> {
    return this.call<null>("savemempool");
  }

  getRawTransaction(txid: string, verbose = true): Promise<RpcTransaction> {
    return this.call<RpcTransaction>("getrawtransaction", [txid, verbose]);
  }

  getTransaction(walletName: string, txid: string): Promise<RpcWalletTransaction> {
    return this.callWallet<RpcWalletTransaction>(walletName, "gettransaction", [txid, true, true]);
  }

  stop(): Promise<string> {
    return this.call<string>("stop");
  }
}
