import { dirname } from "node:path";

import {
  formatBalanceReport,
  formatDetailedWalletStatusReport,
  formatDomainReport,
  formatDomainsReport,
  formatFieldReport,
  formatFieldsReport,
  formatFundingAddressReport,
  formatIdentityListReport,
  formatLocksReport,
} from "../wallet-format.js";
import { writeLine } from "../io.js";
import { findWalletDomain, listDomainFields } from "../../wallet/read/index.js";
import { filterWalletDomains } from "../../wallet/read/index.js";
import {
  createErrorEnvelope,
  createSuccessEnvelope,
  describeCanonicalCommand,
  normalizeListPage,
  type JsonPage,
  writeJsonValue,
} from "../output.js";
import {
  buildAddressJson,
  buildBalanceJson,
  buildDomainsJson,
  buildFieldJson,
  buildFieldsJson,
  buildIdsJson,
  buildLocksJson,
  buildShowJson,
  buildWalletStatusJson,
  listFieldsForJson,
  listLocksForJson,
} from "../read-json.js";
import {
  formatNextStepLines,
  getAddressNextSteps,
  getFundingQuickstartGuidance,
  getIdsNextSteps,
  getLocksNextSteps,
} from "../workflow-hints.js";
import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";
import { withInteractiveWalletSecretProvider } from "../../wallet/state/provider.js";

function createUnknownPage(parsed: ParsedCliArgs, defaultLimit: number): JsonPage {
  return {
    limit: parsed.listAll ? null : (parsed.listLimit ?? defaultLimit),
    returned: 0,
    truncated: false,
    moreAvailable: null,
    totalKnown: null,
  };
}

function activeDomainFilters(parsed: ParsedCliArgs): string[] {
  const filters: string[] = [];

  if (parsed.domainsAnchoredOnly) {
    filters.push("--anchored");
  }

  if (parsed.domainsListedOnly) {
    filters.push("--listed");
  }

  if (parsed.domainsMineableOnly) {
    filters.push("--mineable");
  }

  return filters;
}

function emitJson(
  context: RequiredCliRunnerContext,
  parsed: ParsedCliArgs,
  schema: string,
  result: {
    data: unknown;
    warnings: string[];
    explanations: string[];
    nextSteps: string[];
  },
): number {
  writeJsonValue(context.stdout, createSuccessEnvelope(
    schema,
    describeCanonicalCommand(parsed),
    result.data,
    {
      warnings: result.warnings,
      explanations: result.explanations,
      nextSteps: result.nextSteps,
    },
  ));
  return 0;
}

export async function runWalletReadCommand(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
): Promise<number> {
  const dbPath = parsed.dbPath ?? context.resolveDefaultClientDatabasePath();
  const dataDir = parsed.dataDir ?? context.resolveDefaultBitcoindDataDir();
  const packageVersion = await context.readPackageVersion();
  const runtimePaths = context.resolveWalletRuntimePaths();
  await context.ensureDirectory(dirname(dbPath));

  const provider = parsed.outputMode === "text"
    ? withInteractiveWalletSecretProvider(context.walletSecretProvider, context.createPrompter())
    : context.walletSecretProvider;
  const readContext = await context.openWalletReadContext({
    dataDir,
    databasePath: dbPath,
    secretProvider: provider,
    expectedIndexerBinaryVersion: packageVersion,
    paths: runtimePaths,
  });

  try {
    switch (parsed.command) {
      case "wallet-status":
        if (parsed.outputMode === "json") {
          return emitJson(context, parsed, "cogcoin/wallet-status/v1", buildWalletStatusJson(readContext));
        }
        writeLine(context.stdout, formatDetailedWalletStatusReport(readContext));
        return 0;
      case "address":
        if (parsed.outputMode === "json") {
          return emitJson(context, parsed, "cogcoin/address/v1", buildAddressJson(readContext));
        }
        writeLine(context.stdout, formatFundingAddressReport(readContext));
        if (readContext.model?.walletAddress !== null && readContext.model?.walletAddress !== undefined) {
          writeLine(context.stdout, `Quickstart: ${getFundingQuickstartGuidance()}`);
        }
        for (const line of formatNextStepLines(
          getAddressNextSteps(readContext, readContext.model?.walletAddress ?? null),
        )) {
          writeLine(context.stdout, line);
        }
        return 0;
      case "ids": {
        const defaultLimit = 100;
        if (parsed.outputMode === "json") {
          return emitJson(context, parsed, "cogcoin/ids/v1", buildIdsJson(
            readContext,
            readContext.model === null
              ? createUnknownPage(parsed, defaultLimit)
              : normalizeListPage([readContext.model.walletAddress ?? `spk:${readContext.model.walletScriptPubKeyHex}`], {
                limit: parsed.listLimit,
                all: parsed.listAll,
                defaultLimit,
              }).page,
          ));
        }

        writeLine(context.stdout, formatIdentityListReport(readContext, {
          limit: parsed.listAll ? null : (parsed.listLimit ?? defaultLimit),
          all: parsed.listAll,
        }));
        if (readContext.model !== null) {
          for (const line of formatNextStepLines(getIdsNextSteps(readContext.model.walletAddress))) {
            writeLine(context.stdout, line);
          }
        }
        return 0;
      }
      case "balance":
        if (parsed.outputMode === "json") {
          return emitJson(context, parsed, "cogcoin/balance/v1", buildBalanceJson(readContext));
        }
        writeLine(context.stdout, formatBalanceReport(readContext));
        return 0;
      case "locks":
      {
        const defaultLimit = 100;
        if (parsed.outputMode === "json") {
          const locks = listLocksForJson(readContext, {
            claimableOnly: parsed.locksClaimableOnly,
            reclaimableOnly: parsed.locksReclaimableOnly,
          });
          if (locks === null) {
            return emitJson(context, parsed, "cogcoin/locks/v1", buildLocksJson(
              readContext,
              null,
              createUnknownPage(parsed, defaultLimit),
            ));
          }

          const { items, page } = normalizeListPage(locks, {
            limit: parsed.listLimit,
            all: parsed.listAll,
            defaultLimit,
          });
          return emitJson(context, parsed, "cogcoin/locks/v1", buildLocksJson(readContext, items, page));
        }

        writeLine(context.stdout, formatLocksReport(readContext, {
          claimableOnly: parsed.locksClaimableOnly,
          reclaimableOnly: parsed.locksReclaimableOnly,
          limit: parsed.listAll ? null : (parsed.listLimit ?? defaultLimit),
          all: parsed.listAll,
        }));
        const locks = listLocksForJson(readContext, {
          claimableOnly: parsed.locksClaimableOnly,
          reclaimableOnly: parsed.locksReclaimableOnly,
        });
        if (locks !== null) {
          const { items } = normalizeListPage(locks, {
            limit: parsed.listLimit,
            all: parsed.listAll,
            defaultLimit,
          });
          for (const line of formatNextStepLines(getLocksNextSteps(items))) {
            writeLine(context.stdout, line);
          }
        }
        return 0;
      }
      case "domains": {
        const defaultLimit = 100;
        const filters = activeDomainFilters(parsed);
        const domains = filterWalletDomains(readContext, {
          anchoredOnly: parsed.domainsAnchoredOnly,
          listedOnly: parsed.domainsListedOnly,
          mineableOnly: parsed.domainsMineableOnly,
        });
        if (parsed.outputMode === "json") {
          if (domains === null) {
            return emitJson(context, parsed, "cogcoin/domains/v1", buildDomainsJson(
              readContext,
              null,
              createUnknownPage(parsed, defaultLimit),
            ));
          }

          const { items, page } = normalizeListPage(domains, {
            limit: parsed.listLimit,
            all: parsed.listAll,
            defaultLimit,
          });
          return emitJson(context, parsed, "cogcoin/domains/v1", buildDomainsJson(readContext, items, page));
        }

        writeLine(context.stdout, formatDomainsReport(readContext, {
          limit: parsed.listAll ? null : (parsed.listLimit ?? defaultLimit),
          all: parsed.listAll,
          domains,
          activeFilters: filters,
        }));
        return 0;
      }
      case "show": {
        const domainName = parsed.args[0]!;
        const domain = findWalletDomain(readContext, domainName);
        if (readContext.snapshot !== null && domain === null) {
          if (parsed.outputMode === "json") {
            writeJsonValue(context.stdout, createErrorEnvelope(
              "cogcoin/show/v1",
              describeCanonicalCommand(parsed),
              "not_found",
              "Domain not found.",
            ));
          } else {
            writeLine(context.stdout, formatDomainReport(readContext, domainName));
          }
          return 3;
        }

        if (parsed.outputMode === "json") {
          return emitJson(context, parsed, "cogcoin/show/v1", buildShowJson(readContext, domainName));
        }
        writeLine(context.stdout, formatDomainReport(readContext, parsed.args[0]!));
        return 0;
      }
      case "fields": {
        const defaultLimit = 100;
        const domainName = parsed.args[0]!;
        const fields = listFieldsForJson(readContext, domainName);
        if (readContext.snapshot !== null && fields === null) {
          if (parsed.outputMode === "json") {
            writeJsonValue(context.stdout, createErrorEnvelope(
              "cogcoin/fields/v1",
              describeCanonicalCommand(parsed),
              "not_found",
              "Domain not found.",
            ));
          } else {
            writeLine(context.stdout, formatFieldsReport(readContext, domainName, {
              limit: parsed.listAll ? null : (parsed.listLimit ?? defaultLimit),
              all: parsed.listAll,
            }));
          }
          return 3;
        }

        if (parsed.outputMode === "json") {
          if (fields === null) {
            return emitJson(context, parsed, "cogcoin/fields/v1", buildFieldsJson(
              readContext,
              domainName,
              null,
              createUnknownPage(parsed, defaultLimit),
            ));
          }

          const { items, page } = normalizeListPage(fields, {
            limit: parsed.listLimit,
            all: parsed.listAll,
            defaultLimit,
          });
          return emitJson(context, parsed, "cogcoin/fields/v1", buildFieldsJson(readContext, domainName, items, page));
        }

        writeLine(context.stdout, formatFieldsReport(readContext, domainName, {
          limit: parsed.listAll ? null : (parsed.listLimit ?? defaultLimit),
          all: parsed.listAll,
        }));
        return 0;
      }
      case "field": {
        const domainName = parsed.args[0]!;
        const fieldName = parsed.args[1]!;
        const domainFields = listDomainFields(readContext, domainName);
        const field = domainFields?.find((entry) => entry.name === fieldName) ?? null;

        if (readContext.snapshot !== null && domainFields === null) {
          if (parsed.outputMode === "json") {
            writeJsonValue(context.stdout, createErrorEnvelope(
              "cogcoin/field/v1",
              describeCanonicalCommand(parsed),
              "not_found",
              "Domain not found.",
            ));
          } else {
            writeLine(context.stdout, formatFieldReport(readContext, domainName, fieldName));
          }
          return 3;
        }

        if (readContext.snapshot !== null && domainFields !== null && field === null) {
          if (parsed.outputMode === "json") {
            writeJsonValue(context.stdout, createErrorEnvelope(
              "cogcoin/field/v1",
              describeCanonicalCommand(parsed),
              "not_found",
              "Field not found.",
            ));
          } else {
            writeLine(context.stdout, formatFieldReport(readContext, domainName, fieldName));
          }
          return 3;
        }

        if (parsed.outputMode === "json") {
          return emitJson(context, parsed, "cogcoin/field/v1", buildFieldJson(readContext, domainName, fieldName));
        }
        writeLine(context.stdout, formatFieldReport(readContext, parsed.args[0]!, parsed.args[1]!));
        return 0;
      }
      default:
        writeLine(context.stderr, `wallet read command not implemented: ${parsed.command}`);
        return 5;
    }
  } finally {
    await readContext.close();
  }
}
