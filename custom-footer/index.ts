import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, statSync, unwatchFile, watchFile } from "node:fs";
import { dirname, join, resolve } from "node:path";

/*
 * Pi's footer detects branch changes with fs.watch on the .git directory.
 * On some bind mounts (for example 9p from a Windows host into a container),
 * git's atomic rewrite of HEAD raises no watch events, so the branch shown
 * never changes. Poll HEAD's stat as well; this works on those mounts.
 */
const HEAD_POLL_INTERVAL_MS = 2_000;

function findGitHeadPath(cwd: string): string | null {
  let dir = resolve(cwd);

  while (true) {
    const gitPath = join(dir, ".git");

    if (existsSync(gitPath)) {
      try {
        if (statSync(gitPath).isDirectory()) {
          const headPath = join(gitPath, "HEAD");
          return existsSync(headPath) ? headPath : null;
        }

        // Worktree or submodule: .git is a file containing "gitdir: <path>".
        const match = readFileSync(gitPath, "utf8").match(/^gitdir:\s*(.+)$/m);

        if (match) {
          const headPath = join(resolve(dir, match[1].trim()), "HEAD");
          return existsSync(headPath) ? headPath : null;
        }
      } catch {
        return null;
      }

      return null;
    }

    const parent = dirname(dir);

    if (parent === dir) {
      return null;
    }

    dir = parent;
  }
}

/*
 * Returns the branch name, "detached", or undefined when HEAD cannot be
 * interpreted (for example a reftable repo), so the caller falls back to Pi.
 */
function readBranchFromHead(headPath: string): string | undefined {
  try {
    const head = readFileSync(headPath, "utf8").trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);

    if (ref && ref[1] !== ".invalid") {
      return ref[1];
    }

    if (/^[0-9a-f]{40,64}$/i.test(head)) {
      return "detached";
    }
  } catch {
    // Fall through to Pi's value.
  }

  return undefined;
}

function formatTokens(count: number): string {
  if (count < 1_000) {
    return count.toString();
  }

  if (count < 10_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }

  if (count < 1_000_000) {
    return `${Math.round(count / 1_000)}k`;
  }

  if (count < 10_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }

  return `${Math.round(count / 1_000_000)}M`;
}

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

function addUsage(totals: UsageTotals, usage: any): void {
  if (!usage) {
    return;
  }

  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.cost += usage.cost?.total ?? 0;
}

export default function footer(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI || ctx.mode !== "tui") {
      return;
    }

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => {
        tui.requestRender();
      });

      const headPath = findGitHeadPath(ctx.cwd);
      let polledBranch = headPath ? readBranchFromHead(headPath) : undefined;

      const onHeadChange = () => {
        if (!headPath) {
          return;
        }

        const next = readBranchFromHead(headPath);

        if (next !== polledBranch) {
          polledBranch = next;
          tui.requestRender();
        }
      };

      if (headPath) {
        watchFile(
          headPath,
          { interval: HEAD_POLL_INTERVAL_MS, persistent: false },
          onHeadChange,
        );
      }

      return {
        dispose() {
          unsubscribe();

          if (headPath) {
            unwatchFile(headPath, onHeadChange);
          }
        },

        invalidate() {},

        render(width: number): string[] {
          /*
           * Cumulative usage
           */
          const usageTotals: UsageTotals = {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
          };

          let latestCacheHitRate: number | undefined;

          for (const entry of ctx.sessionManager.getEntries()) {
            if (
              entry.type === "message" &&
              entry.message.role === "assistant"
            ) {
              const usage = entry.message.usage;

              addUsage(usageTotals, usage);

              const latestPromptTokens =
                (usage?.input ?? 0) +
                (usage?.cacheRead ?? 0) +
                (usage?.cacheWrite ?? 0);

              latestCacheHitRate =
                latestPromptTokens > 0
                  ? ((usage?.cacheRead ?? 0) / latestPromptTokens) * 100
                  : undefined;
            } else if (
              entry.type === "message" &&
              entry.message.role === "toolResult" &&
              entry.message.usage
            ) {
              addUsage(usageTotals, entry.message.usage);
            } else if (
              (entry.type === "branch_summary" ||
                entry.type === "compaction") &&
              entry.usage
            ) {
              addUsage(usageTotals, entry.usage);
            }
          }

          /*
           * First line:
           *
           * /workspace (main) • pi-test
           */
          let pwd = ctx.cwd;

          const branch = polledBranch ?? footerData.getGitBranch();

          if (branch) {
            pwd += ` (${branch})`;
          }

          const sessionName = ctx.sessionManager.getSessionName();

          if (sessionName) {
            pwd += ` • ${sessionName}`;
          }

          /*
           * Second line, left side:
           *
           * ↑394k ↓24k R4.4M CH93.9% $3.802 (sub)
           * 244k/1.1M (23.2%) (auto)
           */
          const statsParts: string[] = [];

          if (usageTotals.input) {
            statsParts.push(`↑${formatTokens(usageTotals.input)}`);
          }

          if (usageTotals.output) {
            statsParts.push(`↓${formatTokens(usageTotals.output)}`);
          }

          if (usageTotals.cacheRead) {
            statsParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
          }

          if (usageTotals.cacheWrite) {
            statsParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
          }

          if (
            (usageTotals.cacheRead > 0 ||
              usageTotals.cacheWrite > 0) &&
            latestCacheHitRate !== undefined
          ) {
            statsParts.push(
              `CH${latestCacheHitRate.toFixed(1)}%`,
            );
          }

          const usingSubscription = ctx.model
            ? ctx.model.provider === "kimi-coding" ||
              ctx.modelRegistry.isUsingOAuth(ctx.model)
            : false;

          if (usageTotals.cost || usingSubscription) {
            statsParts.push(
              `$${usageTotals.cost.toFixed(3)}` +
                (usingSubscription ? " (sub)" : ""),
            );
          }

          /*
           * This is the only meaningful change from Pi's native footer.
           */
          const context = ctx.getContextUsage();

          const contextWindow =
            context?.contextWindow ??
            ctx.model?.contextWindow ??
            0;

          const contextTokens = context?.tokens;
          const contextPercent = context?.percent;

          let contextDisplay: string;

          if (
            contextTokens === null ||
            contextTokens === undefined ||
            contextPercent === null ||
            contextPercent === undefined
          ) {
            contextDisplay =
              `?/${formatTokens(contextWindow)} (?) (auto)`;
          } else {
            contextDisplay =
              `${formatTokens(contextTokens)}/` +
              `${formatTokens(contextWindow)} ` +
              `(${contextPercent.toFixed(1)}%) ` +
              `(auto)`;
          }

          /*
           * Keep Pi's normal warning colours.
           */
          if (
            contextPercent !== null &&
            contextPercent !== undefined &&
            contextPercent > 90
          ) {
            contextDisplay = theme.fg(
              "error",
              contextDisplay,
            );
          } else if (
            contextPercent !== null &&
            contextPercent !== undefined &&
            contextPercent > 70
          ) {
            contextDisplay = theme.fg(
              "warning",
              contextDisplay,
            );
          }

          statsParts.push(contextDisplay);

          let statsLeft = statsParts.join(" ");
          let statsLeftWidth = visibleWidth(statsLeft);

          if (statsLeftWidth > width) {
            statsLeft = truncateToWidth(
              statsLeft,
              width,
              "...",
            );

            statsLeftWidth = visibleWidth(statsLeft);
          }

          /*
           * Second line, right side:
           *
           * gpt-5.6-sol • high
           */
          const modelName = ctx.model?.id ?? "no-model";

          let rightSideWithoutProvider = modelName;

          if (ctx.model?.reasoning) {
            const thinkingLevel =
              ctx.thinkingLevel ?? "off";

            rightSideWithoutProvider =
              thinkingLevel === "off"
                ? `${modelName} • thinking off`
                : `${modelName} • ${thinkingLevel}`;
          }

          let rightSide = rightSideWithoutProvider;

          if (
            footerData.getAvailableProviderCount() > 1 &&
            ctx.model
          ) {
            const withProvider =
              `(${ctx.model.provider}) ` +
              rightSideWithoutProvider;

            if (
              statsLeftWidth +
                2 +
                visibleWidth(withProvider) <=
              width
            ) {
              rightSide = withProvider;
            }
          }

          const rightSideWidth = visibleWidth(rightSide);

          let statsLine: string;

          if (
            statsLeftWidth + 2 + rightSideWidth <=
            width
          ) {
            const padding = " ".repeat(
              width -
                statsLeftWidth -
                rightSideWidth,
            );

            statsLine =
              statsLeft + padding + rightSide;
          } else {
            const availableForRight =
              width - statsLeftWidth - 2;

            if (availableForRight > 0) {
              const truncatedRight = truncateToWidth(
                rightSide,
                availableForRight,
                "",
              );

              const padding = " ".repeat(
                Math.max(
                  0,
                  width -
                    statsLeftWidth -
                    visibleWidth(truncatedRight),
                ),
              );

              statsLine =
                statsLeft +
                padding +
                truncatedRight;
            } else {
              statsLine = statsLeft;
            }
          }

          /*
           * Preserve native dim styling.
           */
          const dimStatsLeft =
            theme.fg("dim", statsLeft);

          const remainder =
            statsLine.slice(statsLeft.length);

          const dimRemainder =
            theme.fg("dim", remainder);

          const pwdLine = truncateToWidth(
            theme.fg("dim", pwd),
            width,
            theme.fg("dim", "..."),
          );

          const lines = [
            pwdLine,
            dimStatsLeft + dimRemainder,
          ];

          /*
           * Preserve status lines from any other extensions.
           */
          const extensionStatuses =
          footerData.getExtensionStatuses() as ReadonlyMap<string, string>;

          if (extensionStatuses.size > 0) {
            const statuses = Array.from(extensionStatuses.entries())
              .sort((a, b) => a[0].localeCompare(b[0]))
              .map(([, text]) => sanitizeStatusText(text));

            lines.push(
              truncateToWidth(
                statuses.join(" "),
                width,
                theme.fg("dim", "..."),
              ),
            );
          }

          return lines;
        },
      };
    });
  });
}