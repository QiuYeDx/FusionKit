import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOCAL_SUBTITLE_SERVER_SESSION_POLICY,
  LocalSubtitleServerSessionError,
  cleanupLocalSubtitleServerSession,
  createLocalSubtitleServerSession,
  isLocalSubtitleServerSession,
  verifyLocalSubtitleServerSession,
} from "../../electron/main/local-subtitle/server-session";

let fixtureRoot: string;
let managedRoot: string;

beforeEach(async () => {
  fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "fusionkit-server-session-test-"),
  );
  managedRoot = path.join(fixtureRoot, "local-subtitle");
});

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("local subtitle server session", () => {
  it("creates, verifies, and removes one opaque private session", async () => {
    const session = await createLocalSubtitleServerSession(managedRoot);

    expect(isLocalSubtitleServerSession(session)).toBe(true);
    expect(Object.isFrozen(session)).toBe(true);
    expect(session.baseRoot).toBe(path.join(managedRoot, "temp"));
    expect(path.dirname(session.root)).toBe(session.baseRoot);
    expect(path.basename(session.root)).toMatch(/^server-/u);
    expect((await readdir(session.root)).sort()).toEqual(["public", "tmp"]);
    await expect(
      verifyLocalSubtitleServerSession(session, { requireEmpty: true }),
    ).resolves.toBeUndefined();

    if (process.platform !== "win32") {
      for (const candidate of [
        managedRoot,
        session.baseRoot,
        session.root,
        session.publicDirectory,
        session.temporaryDirectory,
      ]) {
        expect((await lstat(candidate)).mode & 0o777).toBe(0o700);
      }
    }

    await writeFile(path.join(session.temporaryDirectory, "runtime.tmp"), "ok");
    await expect(cleanupLocalSubtitleServerSession(session)).resolves.toEqual({
      removed: true,
    });
    await expect(cleanupLocalSubtitleServerSession(session)).resolves.toEqual({
      removed: false,
    });
  });

  it.each(["relative/root", path.parse(process.cwd()).root])(
    "rejects unsafe managed root %s",
    async (candidate) => {
      await expect(createLocalSubtitleServerSession(candidate)).rejects.toBeInstanceOf(
        LocalSubtitleServerSessionError,
      );
    },
  );

  it("rejects a symlinked managed root without deleting its target", async () => {
    const target = path.join(fixtureRoot, "target");
    const link = path.join(fixtureRoot, "managed-link");
    await mkdir(target, { mode: 0o700 });
    await writeFile(path.join(target, "sentinel"), "keep");
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");

    await expect(createLocalSubtitleServerSession(link)).rejects.toMatchObject({
      code: "session_identity_mismatch",
    });
    await expect(readFile(path.join(target, "sentinel"), "utf8")).resolves.toBe(
      "keep",
    );
  });

  it("rejects a symlinked temp root without touching the external directory", async () => {
    const external = path.join(fixtureRoot, "external");
    await Promise.all([
      mkdir(managedRoot, { mode: 0o700 }),
      mkdir(external, { mode: 0o700 }),
    ]);
    await writeFile(path.join(external, "sentinel"), "keep");
    await symlink(
      external,
      path.join(managedRoot, LOCAL_SUBTITLE_SERVER_SESSION_POLICY.managedTempLeaf),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(createLocalSubtitleServerSession(managedRoot)).rejects.toMatchObject({
      code: "session_identity_mismatch",
    });
    await expect(readFile(path.join(external, "sentinel"), "utf8")).resolves.toBe(
      "keep",
    );
  });

  it("detects non-empty launch directories", async () => {
    const session = await createLocalSubtitleServerSession(managedRoot);
    await writeFile(path.join(session.publicDirectory, "secret.txt"), "secret");

    await expect(
      verifyLocalSubtitleServerSession(session, { requireEmpty: true }),
    ).rejects.toMatchObject({ code: "session_identity_mismatch" });
    await expect(cleanupLocalSubtitleServerSession(session)).resolves.toEqual({
      removed: true,
    });
  });

  it("refuses to delete a replacement at the owned session path", async () => {
    const session = await createLocalSubtitleServerSession(managedRoot);
    const original = `${session.root}.moved`;
    await rename(session.root, original);
    await mkdir(session.root, { mode: 0o700 });
    await Promise.all([
      mkdir(path.join(session.root, "public"), { mode: 0o700 }),
      mkdir(path.join(session.root, "tmp"), { mode: 0o700 }),
    ]);
    await writeFile(path.join(session.root, "sentinel"), "replacement");

    await expect(cleanupLocalSubtitleServerSession(session)).rejects.toMatchObject({
      code: "session_identity_mismatch",
    });
    await expect(readFile(path.join(session.root, "sentinel"), "utf8")).resolves.toBe(
      "replacement",
    );
  });

  it("fails closed when the owned session disappears without quarantine", async () => {
    const session = await createLocalSubtitleServerSession(managedRoot);
    const moved = `${session.root}.moved-elsewhere`;
    await rename(session.root, moved);

    await expect(cleanupLocalSubtitleServerSession(session)).rejects.toMatchObject({
      code: "session_identity_mismatch",
    });
    expect(await readdir(moved)).toEqual(["public", "tmp"]);

    await rename(moved, session.root);
    await expect(cleanupLocalSubtitleServerSession(session)).resolves.toEqual({
      removed: true,
    });
  });

  it("rejects structural copies without the opaque session proof", async () => {
    const session = await createLocalSubtitleServerSession(managedRoot);

    expect(isLocalSubtitleServerSession({ ...session })).toBe(false);
    await expect(
      verifyLocalSubtitleServerSession({ ...session } as never),
    ).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(cleanupLocalSubtitleServerSession(session)).resolves.toEqual({
      removed: true,
    });
  });

  it("rejects a pre-existing temp root with unsafe POSIX permissions", async () => {
    if (process.platform === "win32") return;
    const tempRoot = path.join(managedRoot, "temp");
    await mkdir(tempRoot, { recursive: true, mode: 0o755 });
    await chmod(tempRoot, 0o755);

    await expect(createLocalSubtitleServerSession(managedRoot)).rejects.toMatchObject({
      code: "session_identity_mismatch",
    });
    expect((await lstat(tempRoot)).mode & 0o077).not.toBe(0);
  });

  it("refuses cleanup after an owned directory permission change", async () => {
    if (process.platform === "win32") return;
    const session = await createLocalSubtitleServerSession(managedRoot);
    await chmod(session.temporaryDirectory, 0o500);

    await expect(verifyLocalSubtitleServerSession(session)).rejects.toMatchObject({
      code: "session_identity_mismatch",
    });
    await expect(cleanupLocalSubtitleServerSession(session)).rejects.toMatchObject({
      code: "session_identity_mismatch",
    });

    await chmod(session.temporaryDirectory, 0o700);
    await expect(cleanupLocalSubtitleServerSession(session)).resolves.toEqual({
      removed: true,
    });
  });

  it("resumes cleanup after the owned root was already quarantined", async () => {
    const session = await createLocalSubtitleServerSession(managedRoot);
    const quarantinePath = `${session.root}.cleanup-${"a".repeat(32)}`;
    await rename(session.root, quarantinePath);

    await expect(cleanupLocalSubtitleServerSession(session)).resolves.toEqual({
      removed: true,
    });
    await expect(lstat(quarantinePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(cleanupLocalSubtitleServerSession(session)).resolves.toEqual({
      removed: false,
    });
  });
});
