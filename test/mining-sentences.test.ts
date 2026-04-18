import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";

import { generateMiningSentences, MiningProviderRequestError } from "../src/wallet/mining/sentences.js";
import { saveBuiltInMiningProviderConfig } from "../src/wallet/mining/config.js";
import { createMiningSentenceRequestLimits } from "../src/wallet/mining/sentence-protocol.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import {
  createMemoryWalletSecretProviderForTesting,
  createWalletSecretReference,
} from "../src/wallet/state/provider.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";

function createMiningSentenceRequest() {
  return {
    schemaVersion: 1 as const,
    requestId: "request-1",
    targetBlockHeight: 101,
    referencedBlockHashDisplay: "11".repeat(32),
    generatedAtUnixMs: 1,
    extraPrompt: null,
    limits: createMiningSentenceRequestLimits(),
    rootDomains: [{
      domainId: 7,
      domainName: "cogdemo",
      requiredWords: ["under", "tree", "monkey", "youth", "basket"] as [string, string, string, string, string],
    }],
  };
}

async function createSentenceGenerationFixture(t: TestContext, options: {
  provider: "openai" | "anthropic";
  modelOverride: string | null;
}) {
  const tempRoot = await createTrackedTempDirectory(t, "cogcoin-mining-sentences");
  const paths = resolveWalletRuntimePathsForTesting({
    homeDirectory: tempRoot,
    platform: "linux",
  });
  const provider = createMemoryWalletSecretProviderForTesting();
  const secretReference = createWalletSecretReference("wallet-root");
  await provider.storeSecret(secretReference.keyId, Buffer.alloc(32, 9));
  await saveBuiltInMiningProviderConfig({
    path: paths.clientConfigPath,
    provider,
    secretReference,
    config: {
      provider: options.provider,
      apiKey: "test-api-key",
      extraPrompt: null,
      modelOverride: options.modelOverride,
      modelSelectionSource: options.modelOverride === null ? "legacy-default" : "custom",
      updatedAtUnixMs: 1,
    },
  });
  return {
    paths,
    provider,
  };
}

test("Anthropic 404 with a model override becomes a not-found provider error", async (t) => {
  const fixture = await createSentenceGenerationFixture(t, {
    provider: "anthropic",
    modelOverride: "claude-sonnet-4-missing",
  });

  await assert.rejects(
    () => generateMiningSentences(createMiningSentenceRequest(), {
      paths: fixture.paths,
      provider: fixture.provider,
      fetchImpl: async () => new Response("", { status: 404 }),
    }),
    (error) => {
      if (!(error instanceof MiningProviderRequestError)) {
        return false;
      }
      assert.equal(error.providerState, "not-found");
      assert.equal(
        error.message,
        "The built-in Anthropic mining provider returned HTTP 404 for model \"claude-sonnet-4-missing\". The configured model override may be invalid. Rerun `cogcoin mine setup` to clear or correct it.",
      );
      return true;
    },
  );
});

test("Anthropic 404 with the default model becomes a not-found provider error", async (t) => {
  const fixture = await createSentenceGenerationFixture(t, {
    provider: "anthropic",
    modelOverride: null,
  });

  await assert.rejects(
    () => generateMiningSentences(createMiningSentenceRequest(), {
      paths: fixture.paths,
      provider: fixture.provider,
      fetchImpl: async () => new Response("", { status: 404 }),
    }),
    (error) => {
      if (!(error instanceof MiningProviderRequestError)) {
        return false;
      }
      assert.equal(error.providerState, "not-found");
      assert.equal(
        error.message,
        "The built-in Anthropic mining provider returned HTTP 404 for default model \"claude-sonnet-4-20250514\". Anthropic may no longer serve that model. Rerun `cogcoin mine setup` to choose a valid override.",
      );
      return true;
    },
  );
});
