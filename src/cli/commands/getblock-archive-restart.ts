import type { ParsedCliArgs, RequiredCliRunnerContext } from "../types.js";

export async function confirmGetblockArchiveRestart(
  parsed: ParsedCliArgs,
  context: RequiredCliRunnerContext,
  options: {
    currentArchiveEndHeight: number | null;
    nextArchiveEndHeight: number;
  },
): Promise<boolean> {
  if (parsed.assumeYes) {
    return true;
  }

  const prompter = context.createPrompter();

  if (!prompter.isInteractive) {
    return false;
  }

  const currentLabel = options.currentArchiveEndHeight === null
    ? "without a getblock archive"
    : `with a getblock archive through height ${options.currentArchiveEndHeight.toLocaleString()}`;
  prompter.writeLine(
    `Managed bitcoind is already running ${currentLabel}. A newer getblock archive through height ${options.nextArchiveEndHeight.toLocaleString()} is available.`,
  );
  const answer = (await prompter.prompt(
    `Restart managed bitcoind to load the getblock archive through height ${options.nextArchiveEndHeight.toLocaleString()}? [y/N]: `,
  )).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}
