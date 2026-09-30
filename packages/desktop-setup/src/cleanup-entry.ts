import { homedir } from "node:os";
import { join } from "node:path";
import { desktopPaths } from "./paths.js";
import { removeDesktopIntegration } from "./lifecycle.js";
import type { DiagnosticItem } from "./contracts.js";

export async function runIntegrationCleanup(args: readonly string[], remove: () => Promise<void | { readonly diagnostics: readonly DiagnosticItem[] }>): Promise<void | { readonly diagnostics: readonly DiagnosticItem[] }> {
  if (args.length !== 1 || args[0] !== "--integration-only") throw new Error("仅允许卸载托管集成");
  return remove();
}

/** Invoked by the NSIS uninstall hook, which already has explicit uninstall authorization. */
export async function startIntegrationCleanup(): Promise<void> {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "win32") throw new Error("Unsupported platform");
  const home = homedir();
  const appData = platform === "win32" ? process.env.LOCALAPPDATA || join(home, "AppData", "Local") : join(home, "Library", "Application Support");
  const paths = desktopPaths({ platform, home, appData });
  try {
    const result = await runIntegrationCleanup(process.argv.slice(2), () => removeDesktopIntegration({ paths, platform, home }));
    if (result?.diagnostics.length) process.stderr.write(`本机集成已卸载；部分恢复文件未清理，请检查后手动处理：\n${result.diagnostics.flatMap(item => item.path ? [item.path] : []).join("\n")}\n`);
  }
  catch {
    // Fixed paths only; no environment values, credentials or upstream errors.
    process.stderr.write(`本机集成清理失败；用户配置、凭据与项目已保留。请检查：\n${paths.launcher}\n通用 Skill：${paths.portableSkill}\nClaude Code 兼容副本：${paths.claudeSkill}\n旧版手动恢复：${paths.legacyCodexSkill}\n`);
    process.exitCode = 1;
  }
}
