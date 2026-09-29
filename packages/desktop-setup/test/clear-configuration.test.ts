import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { desktopPaths } from "../src/paths.js";
import { createConfirmationSession, clearDesktopConfiguration, desktopCredentialRefs } from "../src/clear-configuration.js";

test("clear needs a current one-time action-bound token, deletes only the profile and three credentials", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hypit-clear-")); t.after(() => rm(home, { recursive: true, force: true }));
  const paths = desktopPaths({ platform: "darwin", home, appData: home });
  await mkdir(dirname(paths.profile), { recursive: true }); await writeFile(paths.profile, "profile");
  await mkdir(join(home, "projects")); await writeFile(join(home, "projects/video.mp4"), "keep");
  const values = new Map(desktopCredentialRefs.map(ref => [ref.key, { secret: "private" }]));
  const deleted: string[] = [];
  const credentialStore = { owns: () => true, resolve: async (ref: any) => values.get(ref.key), put: async (ref: any, value: any) => { values.set(ref.key, value); }, delete: async (ref: any) => { deleted.push(ref.key); return values.delete(ref.key); } };
  let now = 100; const session = createConfirmationSession(() => now);
  const options = { paths, credentialStore, session };
  await assert.rejects(clearDesktopConfiguration({ ...options, token: "wrong" }), /CONFIRMATION/);
  const expired = session.issue("clear", [paths.profile]); now += 60_001;
  await assert.rejects(clearDesktopConfiguration({ ...options, token: expired.token }), /CONFIRMATION/);
  assert.deepEqual(deleted, []); assert.equal(await readFile(paths.profile, "utf8"), "profile");
  const token = session.issue("clear", [paths.profile, ...desktopCredentialRefs.map(ref => ref.key)]).token;
  const result = await clearDesktopConfiguration({ ...options, token });
  assert.equal(result.profilePresent, true); assert.equal(result.credentials.filter(item => item.present).length, 3);
  assert.deepEqual(deleted.sort(), desktopCredentialRefs.map(ref => ref.key).sort());
  assert.equal(await readFile(join(home, "projects/video.mp4"), "utf8"), "keep");
  await assert.rejects(clearDesktopConfiguration({ ...options, token }), /CONFIRMATION/);
});

test("confirmation is session/action/target bound and invalidation expires every token", () => {
  const a = createConfirmationSession(), b = createConfirmationSession();
  const issued = a.issue("clear", ["/profile", "key"]);
  assert.throws(() => b.consume(issued.token, "clear", issued.targets), /CONFIRMATION/);
  assert.throws(() => a.consume(issued.token, "integration", issued.targets), /CONFIRMATION/);
  const next = a.issue("clear", ["/profile"]);
  assert.throws(() => a.consume(next.token, "clear", ["/other"]), /CONFIRMATION/);
  const last = a.issue("clear", ["/profile"]); a.invalidate();
  assert.throws(() => a.consume(last.token, "clear", last.targets), /CONFIRMATION/);
});

test("clear refuses profile symlinks before deleting credentials", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hypit-clear-link-")); t.after(() => rm(home, { recursive: true, force: true }));
  const paths = desktopPaths({ platform: "darwin", home, appData: home });
  await mkdir(dirname(paths.profile), { recursive: true }); await writeFile(join(home, "project"), "keep"); await symlink(join(home, "project"), paths.profile);
  let writes = 0;
  const credentialStore = { owns: () => true, resolve: async () => undefined, put: async () => { writes++; }, delete: async () => { writes++; return false; } };
  const session = createConfirmationSession(); const targets = [paths.profile, ...desktopCredentialRefs.map(ref => ref.key)];
  await assert.rejects(clearDesktopConfiguration({ paths, credentialStore, session, token: session.issue("clear", targets).token }));
  assert.equal(writes, 0); assert.equal(await readFile(join(home, "project"), "utf8"), "keep");
});

test("partial credential deletion failure restores credentials and profile without echoing secrets", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hypit-clear-rollback-")); t.after(() => rm(home, { recursive: true, force: true }));
  const paths = desktopPaths({ platform: "darwin", home, appData: home });
  await mkdir(dirname(paths.profile), { recursive: true }); await writeFile(paths.profile, "original");
  const original = desktopCredentialRefs.map(ref => [ref.key, { secret: `private-${ref.key}` }] as const);
  const values = new Map(original); let deletes = 0;
  const credentialStore = { owns: () => true, resolve: async (ref: any) => values.get(ref.key), put: async (ref: any, value: any) => { values.set(ref.key, value); }, delete: async (ref: any) => {
    const result = values.delete(ref.key); if (++deletes === 2) throw new Error("private-secret"); return result;
  } };
  const session = createConfirmationSession(); const token = session.issue("clear", [paths.profile, ...desktopCredentialRefs.map(ref => ref.key)]).token;
  await assert.rejects(clearDesktopConfiguration({ paths, credentialStore, session, token }), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /CLEAR_FAILED/); assert.ok(!error.message.includes("private")); return true;
  });
  assert.equal(await readFile(paths.profile, "utf8"), "original");
  for (const [key, value] of original) assert.deepEqual(values.get(key), value);
});
