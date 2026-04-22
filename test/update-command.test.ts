import assert from "node:assert/strict";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { runUpdateCommand } from "../src/cli/commands/update.js";
import { createDefaultContext } from "../src/cli/context.js";
import { parseCliArgs } from "../src/cli/parse.js";
import { runCli } from "../src/cli/runner.js";
import { resolveWalletRuntimePathsForTesting } from "../src/wallet/runtime.js";
import { createMemoryWalletSecretProviderForTesting } from "../src/wallet/state/provider.js";
import { createTrackedTempDirectory } from "./bitcoind-helpers.js";
import { createWalletReadContext } from "./current-model-helpers.js";

const CURRENT_VERSION = "1.1.8";
const NEXT_VERSION = "1.1.9";

function createStringWriter(isTTY = false) {
  let text = "";

  return {
    stream: {
      isTTY,
      write(chunk: string) {
        text += chunk;
      },
    },
    read() {
      return text;
    },
  };
}

function createPrompter(options: {
  interactive: boolean;
  answers?: string[];
}) {
  const prompts: string[] = [];
  const lines: string[] = [];
  const answers = [...(options.answers ?? [])];

  return {
    prompts,
    lines,
    prompter: {
      isInteractive: options.interactive,
      writeLine(message: string) {
        lines.push(message);
      },
      async prompt(message: string) {
        prompts.push(message);
        return answers.shift() ?? "";
      },
    },
  };
}

function createVersionFetch(
  latestVersion: string,
  callCounter: { count: number },
): typeof fetch {
  return (async () => {
    callCounter.count += 1;
    return new Response(JSON.stringify({ version: latestVersion }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    });
  }) as typeof fetch;
}

function createTestRuntimePaths(homeDirectory: string) {
  return () => resolveWalletRuntimePathsForTesting({
    platform: "linux",
    homeDirectory,
    env: {
      ...process.env,
      XDG_DATA_HOME: join(homeDirectory, "data-home"),
      XDG_CONFIG_HOME: join(homeDirectory, "config-home"),
      XDG_STATE_HOME: join(homeDirectory, "state-home"),
      XDG_RUNTIME_DIR: join(homeDirectory, "runtime-home"),
    },
  });
}

async function createUpdateTestContext(
  t: TestContext,
  options: {
    currentVersion: string;
    latestVersion?: string;
    fetchImpl?: typeof fetch;
    interactive?: boolean;
    promptAnswers?: string[];
    stdoutTTY?: boolean;
    stderrTTY?: boolean;
    onInstall?: (options: {
      stdout: { write(chunk: string): void };
      stderr: { write(chunk: string): void };
      env: NodeJS.ProcessEnv;
    }) => Promise<void>;
  },
) {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-update-command");
  const cachePath = join(homeDirectory, "update-check.json");
  const stdout = createStringWriter(options.stdoutTTY ?? false);
  const stderr = createStringWriter(options.stderrTTY ?? false);
  const fetchCalls = { count: 0 };
  const installCalls = { count: 0 };
  const prompt = createPrompter({
    interactive: options.interactive ?? false,
    answers: options.promptAnswers,
  });

  const context = createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: {
      ...process.env,
    },
    fetchImpl: options.fetchImpl ?? createVersionFetch(options.latestVersion ?? options.currentVersion, fetchCalls),
    readPackageVersion: async () => options.currentVersion,
    resolveUpdateCheckStatePath: () => cachePath,
    createPrompter: () => prompt.prompter,
    runGlobalClientUpdateInstall: async (installOptions) => {
      installCalls.count += 1;
      if (options.onInstall !== undefined) {
        await options.onInstall(installOptions);
      }
    },
  });

  return {
    cachePath,
    context,
    fetchCalls,
    installCalls,
    prompt,
    stderr,
    stdout,
  };
}

test("update text output reports already up-to-date without invoking npm", async (t) => {
  const harness = await createUpdateTestContext(t, {
    currentVersion: CURRENT_VERSION,
    latestVersion: CURRENT_VERSION,
  });

  const exitCode = await runUpdateCommand(parseCliArgs(["update"]), harness.context);

  assert.equal(exitCode, 0);
  assert.equal(harness.installCalls.count, 0);
  assert.equal(harness.prompt.prompts.length, 0);
  assert.match(harness.stdout.read(), /Current version: 1\.1\.8/);
  assert.match(harness.stdout.read(), /Latest version: 1\.1\.8/);
  assert.match(harness.stdout.read(), /Cogcoin is already up to date\./);
  assert.equal(harness.stderr.read(), "");
});

test("update text output prompts and invokes npm when a newer version is available", async (t) => {
  const harness = await createUpdateTestContext(t, {
    currentVersion: CURRENT_VERSION,
    latestVersion: NEXT_VERSION,
    interactive: true,
    promptAnswers: ["y"],
    onInstall: async ({ stdout }) => {
      stdout.write("npm install output\n");
    },
  });

  const exitCode = await runUpdateCommand(parseCliArgs(["update"]), harness.context);

  assert.equal(exitCode, 0);
  assert.equal(harness.installCalls.count, 1);
  assert.deepEqual(harness.prompt.prompts, ["Install update now? [Y/n]: "]);
  assert.match(harness.stdout.read(), /Current version: 1\.1\.8/);
  assert.match(harness.stdout.read(), /Latest version: 1\.1\.9/);
  assert.match(harness.stdout.read(), /Installing update\.\.\./);
  assert.match(harness.stdout.read(), /npm install output/);
  assert.match(harness.stdout.read(), /Update completed\. The next cogcoin invocation will use the new install\./);
});

test("update text output exits cleanly when the prompt is declined", async (t) => {
  const harness = await createUpdateTestContext(t, {
    currentVersion: CURRENT_VERSION,
    latestVersion: NEXT_VERSION,
    interactive: true,
    promptAnswers: ["n"],
  });

  const exitCode = await runUpdateCommand(parseCliArgs(["update"]), harness.context);

  assert.equal(exitCode, 0);
  assert.equal(harness.installCalls.count, 0);
  assert.equal(harness.prompt.prompts.length, 1);
  assert.match(harness.stdout.read(), /Update canceled\./);
});

test("update requires an interactive terminal without --yes when a newer version is available", async (t) => {
  const harness = await createUpdateTestContext(t, {
    currentVersion: CURRENT_VERSION,
    latestVersion: NEXT_VERSION,
    interactive: false,
  });

  const exitCode = await runUpdateCommand(parseCliArgs(["update"]), harness.context);

  assert.equal(exitCode, 2);
  assert.equal(harness.installCalls.count, 0);
  assert.match(harness.stderr.read(), /interactive terminal/i);
  assert.match(harness.stderr.read(), /--yes/);
});

test("update --yes skips prompting and invokes npm", async (t) => {
  const harness = await createUpdateTestContext(t, {
    currentVersion: CURRENT_VERSION,
    latestVersion: NEXT_VERSION,
    interactive: false,
  });

  const exitCode = await runUpdateCommand(parseCliArgs(["update", "--yes"]), harness.context);

  assert.equal(exitCode, 0);
  assert.equal(harness.installCalls.count, 1);
  assert.equal(harness.prompt.prompts.length, 0);
});

test("update registry failures map to cli_update_registry_unavailable", async (t) => {
  const harness = await createUpdateTestContext(t, {
    currentVersion: CURRENT_VERSION,
    fetchImpl: (async () => {
      throw new Error("network");
    }) as typeof fetch,
  });

  const exitCode = await runUpdateCommand(parseCliArgs(["update"]), harness.context);

  assert.equal(exitCode, 2);
  assert.equal(harness.stdout.read(), "");
  assert.match(harness.stderr.read(), /Cogcoin could not read the latest client version from the npm registry\./);
});

test("update missing npm failures map to cli_update_npm_not_found", async (t) => {
  const harness = await createUpdateTestContext(t, {
    currentVersion: CURRENT_VERSION,
    latestVersion: NEXT_VERSION,
    onInstall: async () => {
      throw new Error("cli_update_npm_not_found");
    },
  });

  const exitCode = await runUpdateCommand(
    parseCliArgs(["update", "--yes"]),
    harness.context,
  );

  assert.equal(exitCode, 2);
  assert.match(harness.stderr.read(), /Cogcoin could not find npm to install the update\./);
});

test("update install failures map to cli_update_install_failed", async (t) => {
  const harness = await createUpdateTestContext(t, {
    currentVersion: CURRENT_VERSION,
    latestVersion: NEXT_VERSION,
    onInstall: async () => {
      throw new Error("cli_update_install_failed");
    },
  });

  const exitCode = await runUpdateCommand(
    parseCliArgs(["update", "--yes"]),
    harness.context,
  );

  assert.equal(exitCode, 2);
  assert.match(harness.stderr.read(), /Cogcoin update installation failed\./);
});

test("passive update notifications still run for ordinary commands", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-update-runner-status");
  const resolvePaths = createTestRuntimePaths(homeDirectory);
  const stdout = createStringWriter(true);
  const stderr = createStringWriter(true);
  const fetchCalls = { count: 0 };
  const readContext = createWalletReadContext();
  const prompt = createPrompter({
    interactive: true,
  });

  const exitCode = await runCli(["status"], createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    fetchImpl: createVersionFetch(NEXT_VERSION, fetchCalls),
    readPackageVersion: async () => CURRENT_VERSION,
    resolveUpdateCheckStatePath: () => join(homeDirectory, "update-check.json"),
    resolveWalletRuntimePaths: () => resolvePaths(),
    resolveDefaultBitcoindDataDir: () => "/tmp/bitcoind",
    resolveDefaultClientDatabasePath: () => "/tmp/cogcoin.db",
    ensureDirectory: async () => undefined,
    openWalletReadContext: async () => ({
      ...readContext,
      async close() {},
    }),
    walletSecretProvider: createMemoryWalletSecretProviderForTesting(),
    createPrompter: () => prompt.prompter,
  }));

  assert.equal(exitCode, 0);
  assert.equal(fetchCalls.count, 1);
  assert.match(
    stderr.read(),
    new RegExp(`Update available: Cogcoin ${CURRENT_VERSION.replaceAll(".", "\\.")} -> ${NEXT_VERSION.replaceAll(".", "\\.")}`),
  );
});

test("cogcoin update skips the passive notifier and performs only the explicit lookup", async (t) => {
  const homeDirectory = await createTrackedTempDirectory(t, "cogcoin-update-runner-explicit");
  const stdout = createStringWriter();
  const stderr = createStringWriter();
  const fetchCalls = { count: 0 };
  let installCalls = 0;

  const exitCode = await runCli(["update", "--yes"], createDefaultContext({
    stdout: stdout.stream,
    stderr: stderr.stream,
    fetchImpl: createVersionFetch(NEXT_VERSION, fetchCalls),
    readPackageVersion: async () => CURRENT_VERSION,
    resolveUpdateCheckStatePath: () => join(homeDirectory, "update-check.json"),
    createPrompter: () => createPrompter({
      interactive: false,
    }).prompter,
    runGlobalClientUpdateInstall: async () => {
      installCalls += 1;
    },
  }));

  assert.equal(exitCode, 0);
  assert.equal(fetchCalls.count, 1);
  assert.equal(installCalls, 1);
});
