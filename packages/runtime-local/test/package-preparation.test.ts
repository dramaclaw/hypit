import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { createRuntimeEndpointAdapterFacet, RuntimeAdapterRegistry } from "@hypit/runtime-kit";
import { hypitHostPackageRoot } from "@hypit/runtime-host-node";
import { externalPackageInstallRoot } from "@hypit/package-loader-node";
import { prepareRuntimeConfigPackages } from "@hypit/runtime-local";
import { setActiveExternalPackageRoots } from "../../package-loader-node/src/location.js";

const sdk = "preparation-fixture-sdk";
async function manifest(root: string, name: string, version: string, dependencies = {}) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name, version, dependencies }));
  return await realpath(root);
}
async function fixture(t: TestContext, selected: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), "hypit-prepare-requirers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const distribution = join(root, "distribution");
  const hostState = join(root, "state");
  const registry = new RuntimeAdapterRegistry();
  for (const name of selected) registry.registerFacet(createRuntimeEndpointAdapterFacet({
    use: `@hypit/${name}`, activate: context => ({ endpoint: {
      instance: { id: context.instance, pool: context.instance }, credentials: [], offers: [], install() {},
    } }),
  }));
  const profile = join(root, "profile.json");
  await writeFile(profile, JSON.stringify({ format: "hypit.runtime-local@1", dataRoot: "./data",
    endpoints: Object.fromEntries(selected.map(name => [name, { use: `@hypit/${name}` }])), bindings: {} }));
  return {
    root, distribution,
    provider: (name: string, version = "1.2.3", dependencies = { [sdk]: version }) =>
      manifest(join(distribution, "packages", name), `@hypit/${name}`, "1.0.0", dependencies),
    privateSdk: (requirer: string, version = "1.2.3") => manifest(join(requirer, "node_modules", sdk), sdk, version),
    hostSdk: async (version = "1.2.3") => {
      const install = externalPackageInstallRoot(hypitHostPackageRoot(hostState), sdk, version);
      await manifest(join(install, "node_modules", sdk), sdk, version); return install;
    },
    prepare: () => prepareRuntimeConfigPackages(profile, { registry, distributionPackageRoot: distribution, hostStateRoot: hostState,
      // This test must never invoke npm/network; a missing fixture installation is a test failure.
      onProgress: event => { if (event.phase === "installing") throw new Error("Unexpected npm preparation"); },
    }),
  };
}

test("an a-unused private dependency cannot satisfy z-selected preparation", async t => {
  const f = await fixture(t, ["z-selected"]);
  await f.privateSdk(await f.provider("a-unused"));
  await f.provider("z-selected");
  const host = await f.hostSdk();
  const reports = await f.prepare();
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.root, host, "the selected caller must use host preparation, not the unrelated private copy");
});

test("every selected requirer must resolve the exact dependency before bundled reuse", async t => {
  const f = await fixture(t, ["a-selected", "z-selected"]);
  await f.privateSdk(await f.provider("a-selected"));
  await f.provider("z-selected");
  await assert.rejects(f.prepare(), /Unexpected npm preparation/u);
});

test("an unrelated missing copy cannot force npm when the selected requirer has its dependency", async t => {
  const f = await fixture(t, ["z-selected"]);
  await f.provider("a-unused");
  const selected = await f.privateSdk(await f.provider("z-selected"));
  assert.equal((await f.prepare())[0]!.root, selected);
});

test("a selected wrong version fails even when an unrelated caller has the exact version", async t => {
  const f = await fixture(t, ["z-selected"]);
  await f.privateSdk(await f.provider("a-unused"));
  await f.privateSdk(await f.provider("z-selected"), "9.9.9");
  await assert.rejects(f.prepare(), /does not match required 1\.2\.3/u);
});

test("multiple exact private copies and different versions are checked per selected requirer", async t => {
  const f = await fixture(t, ["first", "second", "third"]);
  const first = await f.privateSdk(await f.provider("first"));
  await f.privateSdk(await f.provider("second"));
  const third = await f.privateSdk(await f.provider("third", "2.0.0"), "2.0.0");
  assert.deepEqual((await f.prepare()).map(({ version, root }) => ({ version, root })), [
    { version: "1.2.3", root: first }, { version: "2.0.0", root: third },
  ]);
});

test("active external roots are not mistaken for a bundled dependency", async t => {
  const f = await fixture(t, ["selected"]);
  await f.provider("selected");
  const external = join(f.root, "external");
  await manifest(join(externalPackageInstallRoot(external, sdk, "1.2.3"), "node_modules", sdk), sdk, "1.2.3");
  setActiveExternalPackageRoots([external]);
  t.after(() => setActiveExternalPackageRoots([]));
  await assert.rejects(f.prepare(), /Unexpected npm preparation/u);
});

test("bundled reuse cannot bypass exact upstream version validation", async t => {
  const f = await fixture(t, ["selected"]);
  await f.privateSdk(await f.provider("selected", "^1.2.3"), "^1.2.3");
  await assert.rejects(f.prepare(), /exact version/u);
});
