import type {
  RpcDecodedPsbt,
  RpcListUnspentEntry,
  RpcWalletCreateFundedPsbtResult,
} from "../../../bitcoind/types.js";
import type { WalletReadContext } from "../../read/index.js";
import type { WalletStateV1 } from "../../types.js";
import {
  buildWalletMutationTransactionWithReserveFallback,
  outpointKey,
  type BuiltWalletMutationTransaction,
  type FixedWalletInput,
  type MutationSender,
} from "../common.js";
import type {
  BuiltRegisterTransaction,
  WalletRegisterRpcClient,
} from "./intent.js";

export interface RegisterTransactionPlan {
  registerKind: "root" | "subdomain";
  sender: MutationSender;
  changeAddress: string;
  fixedInputs: FixedWalletInput[];
  outputs: unknown[];
  changePosition: number;
  expectedOpReturnScriptHex: string;
  expectedTreasuryOutputIndex: number | null;
  expectedTreasuryScriptHex: string | null;
  expectedTreasuryValueSats: bigint | null;
  allowedFundingScriptPubKeyHex: string;
  eligibleFundingOutpointKeys: Set<string>;
}

function satsToBtcNumber(value: bigint): number {
  return Number(value) / 100_000_000;
}

function valueToSats(value: number | string): bigint {
  const text = typeof value === "number" ? value.toFixed(8) : value;
  const match = /^(-?)(\d+)(?:\.(\d{0,8}))?$/.exec(text.trim());

  if (match == null) {
    throw new Error(`wallet_register_invalid_amount_${text}`);
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2] ?? "0");
  const fraction = BigInt((match[3] ?? "").padEnd(8, "0"));
  return sign * ((whole * 100_000_000n) + fraction);
}

function encodeOpReturnScript(payload: Uint8Array): string {
  if (payload.length <= 75) {
    return Buffer.concat([
      Buffer.from([0x6a, payload.length]),
      Buffer.from(payload),
    ]).toString("hex");
  }

  return Buffer.concat([
    Buffer.from([0x6a, 0x4c, payload.length]),
    Buffer.from(payload),
  ]).toString("hex");
}

export function extractOpReturnPayloadFromScriptHex(scriptHex: string): Uint8Array | null {
  const bytes = Buffer.from(scriptHex, "hex");

  if (bytes.length < 2 || bytes[0] !== 0x6a) {
    return null;
  }

  const opcode = bytes[1];

  if (opcode <= 75) {
    const end = 2 + opcode;
    return end === bytes.length ? bytes.subarray(2, end) : null;
  }

  if (opcode === 0x4c && bytes.length >= 3) {
    const length = bytes[2];
    const end = 3 + length;
    return end === bytes.length ? bytes.subarray(3, end) : null;
  }

  return null;
}

function isSpendableConfirmedUtxo(entry: RpcListUnspentEntry): boolean {
  return entry.confirmations >= 1
    && entry.spendable !== false
    && entry.safe !== false;
}

function sortUtxos(entries: RpcListUnspentEntry[]): RpcListUnspentEntry[] {
  return entries
    .slice()
    .sort((left, right) =>
      right.amount - left.amount
      || left.txid.localeCompare(right.txid)
      || left.vout - right.vout);
}

function listFundingUtxos(
  entries: RpcListUnspentEntry[],
  fundingScriptPubKeyHex: string,
): RpcListUnspentEntry[] {
  return sortUtxos(entries.filter((entry) =>
    isSpendableConfirmedUtxo(entry) && entry.scriptPubKey === fundingScriptPubKeyHex
  ));
}

function buildRootRegisterOutputs(options: {
  domainName: string;
  treasuryAddress: string;
  treasuryScriptPubKeyHex: string;
  priceSats: bigint;
  serializeDomainReg(domainName: string): { opReturnData: Uint8Array };
}): {
  outputs: unknown[];
  changePosition: number;
  expectedOpReturnScriptHex: string;
} {
  const payload = options.serializeDomainReg(options.domainName).opReturnData;
  const outputs: unknown[] = [
    { data: Buffer.from(payload).toString("hex") },
    { [options.treasuryAddress]: satsToBtcNumber(options.priceSats) },
  ];

  return {
    outputs,
    changePosition: outputs.length,
    expectedOpReturnScriptHex: encodeOpReturnScript(payload),
  };
}

function buildSubdomainRegisterOutputs(options: {
  domainName: string;
  serializeDomainReg(domainName: string): { opReturnData: Uint8Array };
}): {
  outputs: unknown[];
  changePosition: number;
  expectedOpReturnScriptHex: string;
} {
  const payload = options.serializeDomainReg(options.domainName).opReturnData;
  return {
    outputs: [{ data: Buffer.from(payload).toString("hex") }],
    changePosition: 1,
    expectedOpReturnScriptHex: encodeOpReturnScript(payload),
  };
}

export function validateFundedDraft(
  decoded: RpcDecodedPsbt,
  funded: RpcWalletCreateFundedPsbtResult,
  plan: RegisterTransactionPlan,
): void {
  const inputs = decoded.tx.vin;
  const outputs = decoded.tx.vout;

  if (inputs.length === 0) {
    throw new Error("wallet_register_missing_sender_input");
  }

  if (outputs[0]?.scriptPubKey?.hex !== plan.expectedOpReturnScriptHex) {
    throw new Error("wallet_register_opreturn_mismatch");
  }

  if (plan.expectedTreasuryScriptHex !== null && plan.expectedTreasuryOutputIndex !== null) {
    if (outputs[plan.expectedTreasuryOutputIndex]?.scriptPubKey?.hex !== plan.expectedTreasuryScriptHex) {
      throw new Error("wallet_register_treasury_output_mismatch");
    }

    if (valueToSats(outputs[plan.expectedTreasuryOutputIndex]?.value ?? 0) < (plan.expectedTreasuryValueSats ?? 0n)) {
      throw new Error("wallet_register_treasury_value_too_small");
    }
  }

  const expectedWithoutChange = 1 + Number(plan.expectedTreasuryOutputIndex !== null);
  if (funded.changepos === -1) {
    if (outputs.length !== expectedWithoutChange) {
      throw new Error("wallet_register_unexpected_output_count");
    }
    return;
  }

  if (funded.changepos !== plan.changePosition || outputs.length !== expectedWithoutChange + 1) {
    throw new Error("wallet_register_change_position_mismatch");
  }

  if (outputs[funded.changepos]?.scriptPubKey?.hex !== plan.allowedFundingScriptPubKeyHex) {
    throw new Error("wallet_register_change_output_mismatch");
  }
}

export function buildRegisterPlan(options: {
  context: WalletReadContext;
  state: WalletStateV1;
  allUtxos: RpcListUnspentEntry[];
  sender: MutationSender;
  registerKind: "root" | "subdomain";
  domainName: string;
  parentDomainName: string | null;
  treasuryAddress: string;
  treasuryScriptPubKeyHex: string;
  rootPriceSats: bigint;
  serializeDomainReg(domainName: string): { opReturnData: Uint8Array };
}): RegisterTransactionPlan {
  void options.context;
  void options.parentDomainName;
  const fundingUtxos = listFundingUtxos(options.allUtxos, options.state.funding.scriptPubKeyHex);

  if (options.registerKind === "root") {
    const rootOutputs = buildRootRegisterOutputs({
      domainName: options.domainName,
      treasuryAddress: options.treasuryAddress,
      treasuryScriptPubKeyHex: options.treasuryScriptPubKeyHex,
      priceSats: options.rootPriceSats,
      serializeDomainReg: options.serializeDomainReg,
    });

    return {
      registerKind: "root",
      sender: options.sender,
      changeAddress: options.state.funding.address,
      fixedInputs: [],
      outputs: rootOutputs.outputs,
      changePosition: rootOutputs.changePosition,
      expectedOpReturnScriptHex: rootOutputs.expectedOpReturnScriptHex,
      expectedTreasuryOutputIndex: 1,
      expectedTreasuryScriptHex: options.treasuryScriptPubKeyHex,
      expectedTreasuryValueSats: options.rootPriceSats,
      allowedFundingScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
      eligibleFundingOutpointKeys: new Set(fundingUtxos.map((entry) => outpointKey(entry))),
    };
  }

  const subdomainOutputs = buildSubdomainRegisterOutputs({
    domainName: options.domainName,
    serializeDomainReg: options.serializeDomainReg,
  });

  return {
    registerKind: "subdomain",
    sender: options.sender,
    changeAddress: options.state.funding.address,
    fixedInputs: [],
    outputs: subdomainOutputs.outputs,
    changePosition: subdomainOutputs.changePosition,
    expectedOpReturnScriptHex: subdomainOutputs.expectedOpReturnScriptHex,
    expectedTreasuryOutputIndex: null,
    expectedTreasuryScriptHex: null,
    expectedTreasuryValueSats: null,
    allowedFundingScriptPubKeyHex: options.state.funding.scriptPubKeyHex,
    eligibleFundingOutpointKeys: new Set(fundingUtxos.map((entry) => outpointKey(entry))),
  };
}

export async function buildRegisterTransaction(options: {
  rpc: WalletRegisterRpcClient;
  walletName: string;
  state: WalletStateV1;
  plan: RegisterTransactionPlan;
  feeRateSatVb: number;
}): Promise<BuiltRegisterTransaction> {
  return buildWalletMutationTransactionWithReserveFallback({
    rpc: options.rpc,
    walletName: options.walletName,
    state: options.state,
    plan: options.plan,
    validateFundedDraft,
    finalizeErrorCode: "wallet_register_finalize_failed",
    mempoolRejectPrefix: "wallet_register_mempool_rejected",
    feeRate: options.feeRateSatVb,
  });
}
