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

function abandonOpenReceipt(addon, request) {
  addon.begin(request);
}

function run() {
  const input = readInput();
  const addon = require(input.addonPath);
  if (
    addon.protocolVersion !== 4 ||
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
  if (input.action === "acknowledge") {
    process.stdout.write(
      `${JSON.stringify(addon.acknowledge(input.request))}\n`,
    );
    return;
  }
  if (input.action === "abandon-open") {
    abandonOpenReceipt(addon, input.request);
    if (typeof globalThis.gc !== "function") {
      throw new Error("explicit garbage collection is unavailable");
    }
    for (let attempt = 0; attempt < 3; attempt += 1) globalThis.gc();
    process.stdout.write(`${JSON.stringify({ state: "abandoned_open" })}\n`);
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
    const acknowledge = capture(() => receipt.acknowledge());
    process.stdout.write(
      `${JSON.stringify({ first, second, acknowledge, terminal: "rollback" })}\n`,
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
    const acknowledge = capture(() => receipt.acknowledge());
    process.stdout.write(
      `${JSON.stringify({ first, second, acknowledge, terminal: "finalize" })}\n`,
    );
    return;
  }
  if (input.action === "acknowledge-crash") {
    receipt[input.decision]();
    receipt.acknowledge();
    throw new Error("the acknowledge crash checkpoint was not reached");
  }
  if (input.action === "acknowledge-error-retry") {
    receipt[input.decision]();
    const first = capture(() => receipt.acknowledge());
    clearFault();
    const second = capture(() => receipt.acknowledge());
    process.stdout.write(
      `${JSON.stringify({ first, second, decision: input.decision })}\n`,
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
