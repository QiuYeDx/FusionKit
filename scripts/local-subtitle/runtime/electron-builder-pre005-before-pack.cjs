const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function pre005BeforePack(context) {
  const runtimeRoot = findRuntimeRoot(
    context?.packager?.config?.extraResources,
  );
  if (!runtimeRoot) {
    throw new Error("PRE-005 runtime preflight failed (media_runtime_missing).");
  }
  const moduleUrl = pathToFileURL(
    path.join(__dirname, "runtime-manifest.mjs"),
  ).href;
  const { verifyRuntimeBundle } = await import(moduleUrl);
  try {
    await verifyRuntimeBundle({
      runtimeRoot,
      platform: process.platform,
      arch: process.arch,
      scope: "all",
      launch: true,
    });
  } catch (error) {
    const code = typeof error?.code === "string"
      ? error.code
      : "media_runtime_invalid";
    throw new Error(`PRE-005 runtime preflight failed (${code}).`);
  }
}

function findRuntimeRoot(extraResources) {
  const entries = extraResources === undefined || extraResources === null
    ? []
    : Array.isArray(extraResources)
      ? extraResources
      : [extraResources];
  const entry = entries.find(
    (candidate) =>
      candidate &&
      typeof candidate === "object" &&
      candidate.to === "local-subtitle" &&
      typeof candidate.from === "string",
  );
  return entry ? path.resolve(entry.from) : null;
}

module.exports = pre005BeforePack;
module.exports.findRuntimeRoot = findRuntimeRoot;
