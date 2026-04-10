import { MAX_NAME_BYTES, MIN_NAME_BYTES } from "./constants.js";

function validateNameCommon(name: string, errorCode: string): void {
  if (name.length < MIN_NAME_BYTES || name.length > MAX_NAME_BYTES) {
    throw new Error(errorCode);
  }

  if (name.startsWith("-") || name.endsWith("-") || name.includes("--")) {
    throw new Error(errorCode);
  }

  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error(errorCode);
  }
}

export function validateDomainName(name: string): void {
  validateNameCommon(name, "wallet_cogop_invalid_domain_name");
}

export function validateFieldName(name: string): void {
  validateNameCommon(name, "wallet_cogop_invalid_field_name");
}
