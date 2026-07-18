import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sha256File } from "./runtime-manifest.mjs";

const execFileAsync = promisify(execFile);

export const FFMPEG_SOURCE_RELEASE = Object.freeze({
  version: "8.1.2",
  archiveFileName: "ffmpeg-8.1.2.tar.xz",
  archiveByteSize: 11_710_924,
  archiveSha256:
    "464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c",
  signatureFileName: "ffmpeg-8.1.2.tar.xz.asc",
  signatureByteSize: 520,
  signatureSha256:
    "0a0963fccd70597838073f3e31b20f4a4d8cc2b5e577472c9a5a1f22624246f8",
  publicKeyFileName: "ffmpeg-devel.asc",
  publicKeyByteSize: 1_709,
  publicKeySha256:
    "397b3becedcd5a98769967ff1ff8501ddc89f8368b8f766e4701377d7dbaabe5",
  signingKeyFingerprint: "FCF986EA15E6E293A5644F10B4322F04D67658D8",
});

export async function verifyPinnedFfmpegSourceRelease(options) {
  const archivePath = path.resolve(requirePath(options.archivePath, "archivePath"));
  const signaturePath = path.resolve(
    requirePath(options.signaturePath, "signaturePath"),
  );
  const publicKeyPath = path.resolve(
    requirePath(options.publicKeyPath, "publicKeyPath"),
  );
  await Promise.all([
    verifyPinnedFile(archivePath, {
      byteSize: FFMPEG_SOURCE_RELEASE.archiveByteSize,
      sha256: FFMPEG_SOURCE_RELEASE.archiveSha256,
      label: "FFmpeg source archive",
    }),
    verifyPinnedFile(signaturePath, {
      byteSize: FFMPEG_SOURCE_RELEASE.signatureByteSize,
      sha256: FFMPEG_SOURCE_RELEASE.signatureSha256,
      label: "FFmpeg detached signature",
    }),
    verifyPinnedFile(publicKeyPath, {
      byteSize: FFMPEG_SOURCE_RELEASE.publicKeyByteSize,
      sha256: FFMPEG_SOURCE_RELEASE.publicKeySha256,
      label: "FFmpeg release signing key",
    }),
  ]);

  if (!options.gpgPath) {
    return {
      status: "not_run_tool_unavailable",
      expectedFingerprint: FFMPEG_SOURCE_RELEASE.signingKeyFingerprint,
    };
  }
  const platform = options.platform ?? process.platform;
  return platform === "win32"
    ? verifyOnWindows({
        archivePath,
        signaturePath,
        publicKeyPath,
        gpgPath: options.gpgPath,
        gpgvPath: requirePath(options.gpgvPath, "gpgvPath"),
        cygpathPath: requirePath(options.cygpathPath, "cygpathPath"),
      })
    : verifyWithPrivateHome({
        archivePath,
        signaturePath,
        publicKeyPath,
        gpgPath: options.gpgPath,
      });
}

export function parseValidSignatureFingerprint(statusOutput) {
  const fingerprint = String(statusOutput).match(
    /^\[GNUPG:\] VALIDSIG ([A-F0-9]{40})\b/mu,
  )?.[1];
  if (fingerprint !== FFMPEG_SOURCE_RELEASE.signingKeyFingerprint) {
    throw new Error("FFmpeg detached signature used an unexpected signing key.");
  }
  return fingerprint;
}

async function verifyOnWindows(options) {
  const workRoot = await mkdtemp(
    path.join(os.tmpdir(), "fusionkit-ffmpeg-gpgv-windows-"),
  );
  try {
    const keyringPath = path.join(workRoot, "ffmpeg-release-key.gpg");
    const [workRootPosix, publicKeyPosix, keyringPosix, signaturePosix, archivePosix] =
      await Promise.all([
        toMsysPath(options.cygpathPath, workRoot),
        toMsysPath(options.cygpathPath, options.publicKeyPath),
        toMsysPath(options.cygpathPath, keyringPath),
        toMsysPath(options.cygpathPath, options.signaturePath),
        toMsysPath(options.cygpathPath, options.archivePath),
      ]);
    const environment = buildWindowsGpgEnvironment(path.dirname(workRoot), workRootPosix, [
      path.dirname(path.resolve(options.gpgPath)),
      path.dirname(path.resolve(options.gpgvPath)),
    ]);
    await runCommand(
      path.resolve(options.gpgPath),
      [
        "--batch",
        "--yes",
        "--homedir",
        workRootPosix,
        "--dearmor",
        "--output",
        keyringPosix,
        publicKeyPosix,
      ],
      { cwd: workRoot, env: environment },
    );
    const verification = await runCommand(
      path.resolve(options.gpgvPath),
      [
        "--status-fd",
        "1",
        "--keyring",
        keyringPosix,
        signaturePosix,
        archivePosix,
      ],
      { cwd: workRoot, env: environment },
    );
    const fingerprint = parseValidSignatureFingerprint(verification.stdout);
    return {
      status: "verified",
      fingerprint,
      verifier: "gpgv_windows_msys_path_adapter",
    };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

async function verifyWithPrivateHome(options) {
  const gpgHome = await mkdtemp(path.join(os.tmpdir(), "fusionkit-ffmpeg-gpg-"));
  await chmod(gpgHome, 0o700);
  try {
    const environment = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C",
      LC_ALL: "C",
      GNUPGHOME: gpgHome,
    };
    await runCommand(
      path.resolve(options.gpgPath),
      ["--homedir", gpgHome, "--batch", "--import", options.publicKeyPath],
      { cwd: gpgHome, env: environment },
    );
    const verification = await runCommand(
      path.resolve(options.gpgPath),
      [
        "--homedir",
        gpgHome,
        "--batch",
        "--status-fd",
        "1",
        "--verify",
        options.signaturePath,
        options.archivePath,
      ],
      { cwd: gpgHome, env: environment },
    );
    const fingerprint = parseValidSignatureFingerprint(verification.stdout);
    return { status: "verified", fingerprint, verifier: "gpg_private_home" };
  } finally {
    await rm(gpgHome, { recursive: true, force: true });
  }
}

async function toMsysPath(cygpathPath, windowsPath) {
  const result = await runCommand(
    path.resolve(cygpathPath),
    ["-u", path.resolve(windowsPath)],
    {
      cwd: path.dirname(path.resolve(windowsPath)),
      env: buildWindowsGpgEnvironment(os.tmpdir()),
    },
  );
  const converted = result.stdout.trim();
  if (!converted.startsWith("/")) {
    throw new Error("Git cygpath did not return an absolute MSYS path.");
  }
  return converted;
}

function buildWindowsGpgEnvironment(tempDirectory, gpgHome, toolDirectories = []) {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const pathEntries = [
    `${systemRoot}\\System32`,
    ...new Set(toolDirectories.map((entry) => path.resolve(entry))),
  ];
  const environment = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PATH: pathEntries.join(path.delimiter),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    TEMP: tempDirectory,
    TMP: tempDirectory,
    LANG: "C",
    LC_ALL: "C",
  };
  if (gpgHome) environment.GNUPGHOME = gpgHome;
  return environment;
}

async function verifyPinnedFile(filePath, expected) {
  const fileStat = await stat(filePath);
  if (
    !fileStat.isFile() ||
    fileStat.size !== expected.byteSize ||
    (await sha256File(filePath)) !== expected.sha256
  ) {
    throw new Error(`${expected.label} failed its pinned integrity check.`);
  }
}

async function runCommand(command, args, options) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, stderr };
  } catch (error) {
    const diagnostic = String(error?.stderr ?? "")
      .trim()
      .split(/\r?\n/u)
      .find(Boolean);
    throw new Error(
      `FFmpeg signature command failed: ${path.basename(command)}` +
        (diagnostic ? ` (${diagnostic.replace(/[A-Za-z]:\\[^\s]+/gu, "<path>")}).` : "."),
    );
  }
}

function requirePath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  return value;
}
