export const COG_PREFIX = new Uint8Array([0x43, 0x4f, 0x47]);
export const MIN_OP_RETURN_BYTES = 4;
export const MAX_OP_RETURN_BYTES = 80;
export const MIN_SCRIPT_PUBKEY_BYTES = 1;
export const MAX_SCRIPT_PUBKEY_BYTES = 67;
export const MIN_NAME_BYTES = 1;
export const MAX_NAME_BYTES = 63;

export const FIELD_FORMAT_BYTES = {
  clear: 0x00,
  bytes: 0x01,
  text: 0x02,
  json: 0x09,
} as const;

export const COG_OPCODES = {
  MINE: 0x01,
  COG_TRANSFER: 0x02,
  COG_LOCK: 0x03,
  COG_CLAIM: 0x04,
  DOMAIN_REG: 0x05,
  DOMAIN_TRANSFER: 0x06,
  DOMAIN_SELL: 0x07,
  DOMAIN_BUY: 0x08,
  FIELD_REG: 0x09,
  DATA_UPDATE: 0x0a,
  SET_ENDPOINT: 0x0b,
  REP_COMMIT: 0x0c,
  REP_REVOKE: 0x0d,
  SET_CANONICAL: 0x0e,
  DOMAIN_ANCHOR: 0x0f,
  SET_DELEGATE: 0x10,
  SET_MINER: 0x11,
} as const;
