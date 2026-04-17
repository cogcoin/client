export {
  extractOpReturnPayloadFromScriptHex,
  registerDomain,
  type RegisterDomainResult,
} from "./register.js";
export type {
  WalletMutationFeeSelectionSource,
  WalletMutationFeeSummary,
} from "./common.js";
export {
  buyDomain,
  parseCogAmountToCogtoshi,
  sellDomain,
  transferDomain,
  type DomainMarketMutationResult,
} from "./domain-market.js";
export {
  claimCogLock,
  lockCogToDomain,
  reclaimCogLock,
  sendCog,
  type CogMutationResult,
} from "./cog.js";
export {
  anchorDomain,
  type AnchorDomainResult,
} from "./anchor.js";
export {
  clearDomainDelegate,
  clearDomainEndpoint,
  clearDomainMiner,
  setDomainCanonical,
  setDomainDelegate,
  setDomainEndpoint,
  setDomainMiner,
  type DomainAdminMutationResult,
} from "./domain-admin.js";
export {
  clearField,
  createField,
  setField,
  type ClearFieldOptions,
  type CreateFieldOptions,
  type FieldMutationResult,
  type FieldValueInputSource,
  type SetFieldOptions,
} from "./field.js";
export {
  giveReputation,
  revokeReputation,
  type GiveReputationOptions,
  type ReputationMutationResult,
  type RevokeReputationOptions,
} from "./reputation.js";
