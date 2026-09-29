import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runIntegrationCleanup } from "../src/cleanup-entry.js";

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
