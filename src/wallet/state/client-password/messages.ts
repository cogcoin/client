export function describeClientPasswordLockedMessage(): string {
  return "Wallet state exists but the client password is locked.";
}

export function describeClientPasswordSetupMessage(): string {
  return "Wallet-local secret access is not configured yet. Run `cogcoin init` to create the client password.";
}

export function describeClientPasswordMigrationMessage(): string {
  return "Wallet-local secret migration is still required. Run `cogcoin init` to migrate this client to password-protected local secrets.";
}
