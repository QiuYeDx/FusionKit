#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function readInput() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (
    typeof input !== "object" ||
    input === null ||
    typeof input.action !== "string" ||
    typeof input.addonPath !== "string"
  ) {
    throw new Error("invalid child input");
  }
  return input;
}

function clearFault() {
  delete process.env.FUSIONKIT_OVERWRITE_TEST_FAULT_ACTION;
  delete process.env.FUSIONKIT_OVERWRITE_TEST_FAULT_POINT;
}

function capture(operation) {
  try {
    operation();
    return undefined;
  } catch (error) {
    return {
      code: error?.code ?? "unknown",
      message: String(error?.message ?? ""),
    };
  }
}

function run() {
  const input = readInput();
  const addon = require(input.addonPath);
  if (
    addon.protocolVersion !== 3 ||
    addon.platform !== "win32" ||
    addon.architecture !== "x64" ||
    addon.testFaultInjection !== true
  ) {
    throw new Error("invalid test addon");
  }
  if (input.action === "recover") {
    process.stdout.write(`${JSON.stringify(addon.recover(input.request))}\n`);
    return;
  }
  const receipt = addon.begin(input.request);
  if (input.action === "begin-crash") {
    throw new Error("the begin crash checkpoint was not reached");
  }
  if (input.action === "rollback-crash") {
    receipt.rollback();
    throw new Error("the rollback crash checkpoint was not reached");
  }
  if (input.action === "rollback-error-retry") {
    const first = capture(() => receipt.rollback());
    clearFault();
    const second = capture(() => receipt.rollback());
    process.stdout.write(
      `${JSON.stringify({ first, second, terminal: "rollback" })}\n`,
    );
    return;
  }
  if (input.action === "finalize-crash") {
    receipt.finalize();
    throw new Error("the finalize crash checkpoint was not reached");
  }
  if (input.action === "finalize-error-retry") {
    const first = capture(() => receipt.finalize());
    clearFault();
    const second = capture(() => receipt.finalize());
    process.stdout.write(
      `${JSON.stringify({ first, second, terminal: "finalize" })}\n`,
    );
    return;
  }
  throw new Error("unknown child action");
}

try {
  run();
} catch (error) {
  process.stderr.write(
    `overwrite_native_windows_recovery_child_failed:${error?.code ?? "unknown"}:` +
      `${String(error?.message ?? "").replaceAll("\r", " ").replaceAll("\n", " ")}\n`,
  );
  process.exitCode = 1;
}
