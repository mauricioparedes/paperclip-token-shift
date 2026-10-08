import { execFile } from "node:child_process";
import type { TokenShiftConfig } from "./config.js";

/**
 * Run `/usage` through the authenticated Claude Code CLI and return its text.
 * `/usage` is a local command: it does not start a model turn or spend quota.
 */
export function runClaudeUsage(config: TokenShiftConfig): Promise<string> {
  const env = { ...process.env };
  if (config.claudeConfigDir) env.CLAUDE_CONFIG_DIR = config.claudeConfigDir;
  return new Promise((resolve, reject) => {
    execFile(
      config.claudeCommand,
      ["-p", "/usage", "--output-format", "json"],
      { env, timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error(`claude /usage failed: ${error.message.split("\n")[0]}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { result?: unknown };
          resolve(typeof parsed.result === "string" ? parsed.result : stdout);
        } catch {
          resolve(stdout);
        }
      },
    );
  });
}
