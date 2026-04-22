import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import { serializeSetEndpoint } from "../../../cogop/index.js";
import {
  confirmEndpointMutation,
} from "../confirm.js";
import {
  createResolvedDomainAdminSenderSummary,
} from "../intent.js";
import type {
  ClearDomainEndpointOptions,
  DomainAdminVariant,
  SetDomainEndpointOptions,
} from "../types.js";

async function loadEndpointPayload(
  source: SetDomainEndpointOptions["source"],
): Promise<Uint8Array> {
  if (source.kind === "text") {
    const value = source.value;
    if (value.length === 0) {
      throw new Error("wallet_domain_endpoint_payload_missing");
    }
    return new TextEncoder().encode(value);
  }

  if (source.kind === "json") {
    const value = source.value.trim();
    if (value.length === 0) {
      throw new Error("wallet_domain_endpoint_payload_missing");
    }
    try {
      JSON.parse(value);
    } catch {
      throw new Error("wallet_domain_endpoint_invalid_json");
    }
    return new TextEncoder().encode(value);
  }

  if (source.value.startsWith("hex:")) {
    const hex = source.value.slice(4);
    if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) {
      throw new Error("wallet_domain_endpoint_invalid_bytes");
    }
    if (hex.length === 0) {
      throw new Error("wallet_domain_endpoint_payload_missing");
    }
    return Buffer.from(hex, "hex");
  }

  if (!source.value.startsWith("@")) {
    throw new Error("wallet_domain_endpoint_invalid_bytes");
  }

  const filePath = source.value.slice(1);
  if (filePath.trim() === "") {
    throw new Error("wallet_domain_endpoint_invalid_bytes");
  }

  const payload = await readFile(resolvePath(process.cwd(), filePath));
  if (payload.length === 0) {
    throw new Error("wallet_domain_endpoint_payload_missing");
  }
  return payload;
}

export async function createSetEndpointVariant(
  options: SetDomainEndpointOptions,
): Promise<DomainAdminVariant> {
  const payloadBytes = await loadEndpointPayload(options.source);

  return {
    kind: "endpoint",
    errorPrefix: "wallet_domain_endpoint",
    intentParts(operation) {
      return [operation.chainDomain.name, Buffer.from(payloadBytes).toString("hex")];
    },
    async createPayload(operation) {
      return {
        opReturnData: serializeSetEndpoint(operation.chainDomain.domainId, payloadBytes).opReturnData,
        endpointValueHex: Buffer.from(payloadBytes).toString("hex"),
        resolvedTarget: null,
        resolvedEffect: {
          kind: "endpoint-set",
          byteLength: payloadBytes.length,
        },
      };
    },
    async confirm(operation) {
      await confirmEndpointMutation(options.prompter, operation.chainDomain.name, payloadBytes, {
        clear: false,
        sender: createResolvedDomainAdminSenderSummary(operation.sender, operation.senderSelector),
        sourceKind: options.source.kind,
        assumeYes: options.assumeYes,
      });
    },
  };
}

export function createClearEndpointVariant(
  options: ClearDomainEndpointOptions,
): DomainAdminVariant {
  return {
    kind: "endpoint",
    errorPrefix: "wallet_domain_endpoint",
    intentParts(operation) {
      return [operation.chainDomain.name, "clear"];
    },
    async createPayload(operation) {
      return {
        opReturnData: serializeSetEndpoint(operation.chainDomain.domainId).opReturnData,
        endpointValueHex: "",
        resolvedTarget: null,
        resolvedEffect: { kind: "endpoint-clear" },
      };
    },
    async confirm(operation) {
      await confirmEndpointMutation(options.prompter, operation.chainDomain.name, new Uint8Array(), {
        clear: true,
        sender: createResolvedDomainAdminSenderSummary(operation.sender, operation.senderSelector),
        assumeYes: options.assumeYes,
      });
    },
  };
}
