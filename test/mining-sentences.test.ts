import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";

import { generateMiningSentences, MiningProviderRequestError } from "../src/wallet/mining/sentences.js";
import { loadClientConfig, saveBuiltInMiningProviderConfig, saveClientConfig } from "../src/wallet/mining/config.js";
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
      extraPrompt: null,
    }],
  };
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
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

test("OpenAI 429 becomes a rate-limited provider error", async (t) => {
  const fixture = await createSentenceGenerationFixture(t, {
    provider: "openai",
    modelOverride: "gpt-5.4-mini",
  });

  await assert.rejects(
    () => generateMiningSentences(createMiningSentenceRequest(), {
      paths: fixture.paths,
      provider: fixture.provider,
      fetchImpl: async () => new Response("", { status: 429 }),
    }),
    (error) => {
      if (!(error instanceof MiningProviderRequestError)) {
        return false;
      }
      assert.equal(error.providerState, "rate-limited");
      assert.equal(error.message, "The built-in OpenAI mining provider is rate limited.");
      return true;
    },
  );
});

test("OpenAI auth rejection becomes an auth-error provider error", async (t) => {
  const fixture = await createSentenceGenerationFixture(t, {
    provider: "openai",
    modelOverride: "gpt-5.4-mini",
  });

  await assert.rejects(
    () => generateMiningSentences(createMiningSentenceRequest(), {
      paths: fixture.paths,
      provider: fixture.provider,
      fetchImpl: async () => new Response("", { status: 401 }),
    }),
    (error) => {
      if (!(error instanceof MiningProviderRequestError)) {
        return false;
      }
      assert.equal(error.providerState, "auth-error");
      assert.equal(error.message, "The built-in OpenAI mining provider rejected the configured API key.");
      return true;
    },
  );
});

test("built-in provider timeouts become timeout-specific unavailable errors", async (t) => {
  const fixture = await createSentenceGenerationFixture(t, {
    provider: "openai",
    modelOverride: "gpt-5.4-mini",
  });
  const request = {
    ...createMiningSentenceRequest(),
    limits: {
      ...createMiningSentenceRequest().limits,
      timeoutMs: 1_000,
    },
  };

  await assert.rejects(
    () => generateMiningSentences(request, {
      paths: fixture.paths,
      provider: fixture.provider,
      fetchImpl: (async (_url, init) => {
        await new Promise((_, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => {
            reject(createAbortError("provider request aborted"));
          }, { once: true });
        });
        throw new Error("unreachable");
      }) as typeof fetch,
    }),
    (error) => {
      if (!(error instanceof MiningProviderRequestError)) {
        return false;
      }
      assert.equal(error.providerState, "unavailable");
      assert.equal(error.message, "The built-in OpenAI mining provider timed out after 1 second.");
      return true;
    },
  );
});

test("caller aborts are not reclassified as provider unavailability", async (t) => {
  const fixture = await createSentenceGenerationFixture(t, {
    provider: "openai",
    modelOverride: "gpt-5.4-mini",
  });
  const controller = new AbortController();

  await assert.rejects(
    async () => {
      const requestPromise = generateMiningSentences(createMiningSentenceRequest(), {
        paths: fixture.paths,
        provider: fixture.provider,
        signal: controller.signal,
        fetchImpl: (async (_url, init) => {
          await new Promise((_, reject) => {
            const signal = init?.signal as AbortSignal | undefined;
            if (signal?.aborted) {
              reject(createAbortError("caller aborted"));
              return;
            }
            signal?.addEventListener("abort", () => {
              reject(createAbortError("caller aborted"));
            }, { once: true });
          });
          throw new Error("unreachable");
        }) as typeof fetch,
      });
      controller.abort();
      await requestPromise;
    },
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "AbortError");
      assert.notEqual(error instanceof MiningProviderRequestError, true);
      return true;
    },
  );
});

test("OpenAI requests include per-domain prompts and the fallback prompt semantics", async (t) => {
  const fixture = await createSentenceGenerationFixture(t, {
    provider: "openai",
    modelOverride: "gpt-5.4-mini",
  });
  const request = {
    ...createMiningSentenceRequest(),
    extraPrompt: "global fallback",
    rootDomains: [
      {
        domainId: 7,
        domainName: "cogdemo",
        requiredWords: ["under", "tree", "monkey", "youth", "basket"] as [string, string, string, string, string],
        extraPrompt: "focus on cogdemo only",
      },
      {
        domainId: 8,
        domainName: "betademo",
        requiredWords: ["able", "breeze", "cabin", "delta", "ember"] as [string, string, string, string, string],
        extraPrompt: null,
      },
    ],
  };
  let capturedBody: {
    input?: Array<{
      content?: string;
    }>;
  } | null = null;

  const result = await generateMiningSentences(request, {
    paths: fixture.paths,
    provider: fixture.provider,
    fetchImpl: (async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          schemaVersion: 1,
          requestId: request.requestId,
          candidates: [],
        }),
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }) as typeof fetch,
  });

  assert.deepEqual(result.candidates, []);
  assert.ok(capturedBody);
  const body = capturedBody as {
    input?: Array<{
      content?: string;
    }>;
  };
  const [systemInput, userInput] = body.input ?? [];
  assert.match(String(systemInput?.content), /Never apply one domain's prompt to another domain's candidates\./);
  assert.match(String(systemInput?.content), /Request-level fallback instruction: global fallback/);
  assert.match(String(userInput?.content), /"extraPrompt": "focus on cogdemo only"/);
  assert.match(String(userInput?.content), /"extraPrompt": null/);
});

test("sentence generation uses only the active built-in provider and ignores remembered inactive providers", async (t) => {
  const fixture = await createSentenceGenerationFixture(t, {
    provider: "openai",
    modelOverride: "gpt-5.4-mini",
  });
  const secretReference = createWalletSecretReference("wallet-root");
  const currentConfig = await loadClientConfig({
    path: fixture.paths.clientConfigPath,
    provider: fixture.provider,
  });

  await saveClientConfig({
    path: fixture.paths.clientConfigPath,
    provider: fixture.provider,
    secretReference,
    config: {
      schemaVersion: 1,
      mining: {
        builtIn: currentConfig?.mining.builtIn ?? null,
        builtInByProvider: {
          openai: currentConfig?.mining.builtIn!,
          anthropic: {
            provider: "anthropic",
            apiKey: "inactive-anthropic-key",
            extraPrompt: "inactive anthropic prompt",
            modelOverride: "claude-haiku-4-5",
            modelSelectionSource: "catalog",
            updatedAtUnixMs: 2,
          },
        },
        domainExtraPrompts: {},
      },
    },
  });

  let capturedUrl: string | null = null;
  let capturedAuthorization: string | null = null;
  let capturedAnthropicKey: string | null = null;

  const result = await generateMiningSentences(createMiningSentenceRequest(), {
    paths: fixture.paths,
    provider: fixture.provider,
    fetchImpl: (async (url, init) => {
      capturedUrl = String(url);
      const headers = new Headers(init?.headers);
      capturedAuthorization = headers.get("authorization");
      capturedAnthropicKey = headers.get("x-api-key");
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          schemaVersion: 1,
          requestId: "request-1",
          candidates: [],
        }),
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    }) as typeof fetch,
  });

  assert.deepEqual(result.candidates, []);
  assert.equal(capturedUrl, "https://api.openai.com/v1/responses");
  assert.equal(capturedAuthorization, "Bearer test-api-key");
  assert.equal(capturedAnthropicKey, null);
});
