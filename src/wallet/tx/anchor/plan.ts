import type { BuiltWalletMutationTransaction } from "../common.js";
import type { DirectAnchorPlan } from "./intent.js";

export function validateDirectAnchorDraft(
  decoded: BuiltWalletMutationTransaction["decoded"],
  funded: BuiltWalletMutationTransaction["funded"],
  plan: DirectAnchorPlan,
): void {
  const outputs = decoded.tx.vout;

  if (outputs[0]?.scriptPubKey?.hex !== plan.expectedOpReturnScriptHex) {
    throw new Error("wallet_anchor_opreturn_mismatch");
  }

  if (funded.changepos === -1) {
    if (outputs.length !== 1) {
      throw new Error("wallet_anchor_unexpected_output_count");
    }
    return;
  }

  if (funded.changepos !== plan.changePosition || outputs.length !== 2) {
    throw new Error("wallet_anchor_change_position_mismatch");
  }

  if (outputs[funded.changepos]?.scriptPubKey?.hex !== plan.allowedFundingScriptPubKeyHex) {
    throw new Error("wallet_anchor_change_output_mismatch");
  }
}
