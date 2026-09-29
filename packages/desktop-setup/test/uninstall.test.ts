import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { runIntegrationCleanup } from "../src/cleanup-entry.js";

const require = createRequire(new URL("../package.json", import.meta.url));

function cleanupCallsInHook(hook: string, updated: boolean): number {
  const body = hook.match(/!macro customUnInstall\s*([\s\S]*?)!macroend/)?.[1];
  assert.ok(body, "customUnInstall macro must exist");
  const active = [true];
  let calls = 0;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "${IfNot} ${isUpdated}") active.push(active.at(-1)! && !updated);
    else if (line === "${If} $0 != 0") active.push(false);
    else if (line === "${EndIf}") {
      assert.ok(active.length > 1, "unexpected NSIS EndIf");
      active.pop();
    } else if (line.includes("nsExec::ExecToStack") && active.at(-1)) calls++;
  }
  assert.equal(active.length, 1, "NSIS conditional blocks must be balanced");
  return calls;
}

test("headless cleanup only accepts exact integration-only operation and never invokes credential cleanup", async () => {
  let count = 0;
  for (const args of [[], ["--clear"], ["--integration-only", "/arbitrary"], ["--integration-only", "--delete-projects"]]) {
    await assert.rejects(runIntegrationCleanup(args, async () => { count++; }));
  }
  await runIntegrationCleanup(["--integration-only"], async () => { count++; });
  assert.equal(count, 1);
});

test("NSIS cleans managed integration before uninstall and reports failure without deleting user data", async () => {
  const hook = await readFile(new URL("../build/installer.nsh", import.meta.url), "utf8");
  assert.match(hook, /customUnInstall/); assert.match(hook, /cleanup\.cjs/); assert.match(hook, /--integration-only/);
  assert.match(hook, /ExecToStack \/TIMEOUT=30000/); assert.match(hook, /MessageBox/);
  assert.doesNotMatch(hook, /RMDir|Delete\s|--clear/);
});

test("NSIS cleanup executes on ordinary uninstall and is skipped during an update", async () => {
  const hook = await readFile(new URL("../build/installer.nsh", import.meta.url), "utf8");
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  const template = await readFile(join(dirname(builderRequire.resolve("app-builder-lib/package.json")), "templates/nsis/uninstaller.nsh"), "utf8");
  const hookInsertion = template.indexOf("!insertmacro customUnInstall");
  const appRemoval = template.indexOf("# delete the installed files");
  assert.ok(hookInsertion > 0 && appRemoval > hookInsertion, "electron-builder must call this hook before deleting app files");
  assert.match(template, /\$\{if\} \$\{isUpdated\}/, "the include context must expose electron-builder's update flag");
  assert.equal(cleanupCallsInHook(hook, false), 1, "ordinary uninstall runs cleanup once");
  assert.equal(cleanupCallsInHook(hook, true), 0, "update must preserve the managed launcher and Skill");
});
