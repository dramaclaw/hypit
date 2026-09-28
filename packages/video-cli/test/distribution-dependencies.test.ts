import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("the installed video Distribution includes NewAPI's eager external dependencies", () => {
  const root = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
    readonly dependencies: Readonly<Record<string, string>>;
  };
  const provider = JSON.parse(readFileSync(resolve(process.cwd(), "packages/provider-newapi/package.json"), "utf8")) as {
    readonly dependencies: Readonly<Record<string, string>>;
  };
  for (const [name, version] of Object.entries(provider.dependencies)) {
    if (version.startsWith("workspace:")) continue;
    assert.equal(root.dependencies[name], version, `${name} must be installed with the video Distribution`);
  }
});
