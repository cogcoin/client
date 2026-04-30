export function createHealthyMiningRpc(
  overrides: Record<string, unknown> = {},
  options: {
    fundingScriptPubKeyHex?: string;
  } = {},
) {
  const fundingScriptPubKeyHex = options.fundingScriptPubKeyHex ?? "0014" + "11".repeat(20);
  let lastFundedRequest:
    | {
      inputs: Array<{ txid: string; vout: number }>;
      outputs: unknown[];
    }
    | null = null;

  return {
    async listLockUnspent() {
      return [];
    },
    async lockUnspent() {
      return true;
    },
    async listUnspent() {
      return [{
        txid: "aa".repeat(32),
        vout: 0,
        amount: 0.001,
        scriptPubKey: fundingScriptPubKeyHex,
        confirmations: 0,
        spendable: true,
        safe: true,
      }];
    },
    async walletCreateFundedPsbt(
      _walletName: string,
      inputs: Array<{ txid: string; vout: number }>,
      outputs: unknown[],
    ) {
      lastFundedRequest = {
        inputs: [...inputs],
        outputs,
      };
      return {
        psbt: "probe-psbt",
        fee: 0.00001,
        changepos: 1,
      };
    },
    async decodePsbt() {
      const opReturnDataHex = typeof (lastFundedRequest?.outputs[0] as { data?: unknown } | undefined)?.data === "string"
        ? (lastFundedRequest?.outputs[0] as { data: string }).data
        : "";
      const pushLengthHex = (opReturnDataHex.length / 2).toString(16).padStart(2, "0");
      return {
        tx: {
          vin: [
            ...(lastFundedRequest?.inputs ?? []),
            {
              txid: "aa".repeat(32),
              vout: 0,
            },
          ],
          vout: [
            {
              n: 0,
              value: 0,
              scriptPubKey: {
                hex: `6a${pushLengthHex}${opReturnDataHex}`,
              },
            },
            {
              n: 1,
              value: 0.00099,
              scriptPubKey: {
                hex: fundingScriptPubKeyHex,
              },
            },
          ],
        },
        inputs: [],
      };
    },
    async getBlockchainInfo() {
      return {
        blocks: 100,
        bestblockhash: "11".repeat(32),
        initialblockdownload: false,
      };
    },
    async getNetworkInfo() {
      return {
        networkactive: true,
        connections_out: 8,
      };
    },
    async getMempoolInfo() {
      return {
        loaded: true,
      };
    },
    async getRawMempoolVerbose() {
      return {
        txids: [],
        mempool_sequence: "seq-0",
      };
    },
    async getRawMempoolEntries() {
      return {};
    },
    async saveMempool() {
      return null;
    },
    ...overrides,
  };
}
