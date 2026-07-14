import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalizeI18nKey,
  checkI18nUsage,
} from "./check-i18n-usage.mjs";

function createFixture(source, localeKeys) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fusionkit-i18n-usage-"));
  fs.mkdirSync(path.join(projectRoot, "src", "locales", "zh"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "src", "locales", "en"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, jsx: "react-jsx" }, include: ["src"] }),
  );
  fs.writeFileSync(path.join(projectRoot, "src", "fixture.tsx"), source);
  for (const language of ["zh", "en"]) {
    fs.writeFileSync(
      path.join(projectRoot, "src", "locales", language, "common.json"),
      JSON.stringify(localeKeys.common ?? {}),
    );
    fs.writeFileSync(
      path.join(projectRoot, "src", "locales", language, "feature.json"),
      JSON.stringify(localeKeys.feature ?? {}),
    );
  }
  return projectRoot;
}

function withFixture(source, localeKeys, callback) {
  const projectRoot = createFixture(source, localeKeys);
  try {
    return callback(projectRoot);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

test("canonicalizes repeated namespace separators like i18next", () => {
  assert.equal(
    canonicalizeI18nKey("feature:section:message"),
    "feature:section.message",
  );
});

test("extracts hook, i18n.t, conditional, template union, map and Trans keys", () => {
  const source = `
    import { Trans, useTranslation } from "react-i18next";
    import i18n from "@/i18n";
    type State = "idle" | "ready";
    const LABELS: Record<State, string> = {
      idle: "feature:map.idle",
      ready: "feature:map.ready",
    };
    export function View({ state }: { state: State }) {
      const { t } = useTranslation("feature");
      return <>
        {t("relative")}
        {t(state === "idle" ? "feature:branch.idle" : "feature:branch.ready")}
        {t(\`feature:state.\${state}\`)}
        {t(LABELS[state])}
        {i18n.t("feature:section:message")}
        <Trans i18nKey="feature:trans" />
      </>;
    }
  `;
  const locale = {
    common: {},
    feature: {
      relative: "Relative",
      branch: { idle: "Idle", ready: "Ready" },
      state: { idle: "Idle", ready: "Ready" },
      map: { idle: "Idle", ready: "Ready" },
      section: { message: "Message" },
      trans: "Trans",
    },
  };
  withFixture(source, locale, (projectRoot) => {
    const report = checkI18nUsage({ projectRoot, manifest: [] });
    assert.equal(report.ok, true, JSON.stringify(report.errors, null, 2));
    assert.equal(report.stats.translationCalls, 6);
  });
});

test("does not treat unrelated colon strings or callback variables named t as keys", () => {
  const source = `
    const channel = "audio:realtime:create";
    const css = "hover:bg-accent";
    [() => 1].map((t) => t());
    export { channel, css };
  `;
  withFixture(source, { common: {}, feature: {} }, (projectRoot) => {
    const report = checkI18nUsage({ projectRoot, manifest: [] });
    assert.equal(report.ok, true, JSON.stringify(report.errors, null, 2));
    assert.equal(report.stats.translationCalls, 0);
  });
});

test("recognizes explicitly typed translator helper parameters", () => {
  const source = `
    type Translate = (key: string) => string;
    function direct(t: Translate) {
      return t("common:direct");
    }
    function destructured({ t }: { t: Translate }) {
      return t("common:destructured");
    }
    export { direct, destructured };
  `;
  const locale = {
    common: { direct: "Direct", destructured: "Destructured" },
    feature: {},
  };
  withFixture(source, locale, (projectRoot) => {
    const report = checkI18nUsage({ projectRoot, manifest: [] });
    assert.equal(report.ok, true, JSON.stringify(report.errors, null, 2));
    assert.equal(report.stats.translationCalls, 2);
  });
});

test("fails unknown dynamic keys and accepts only a matching exact manifest", () => {
  const source = `
    import { useTranslation } from "react-i18next";
    export function View({ keyName }: { keyName: string }) {
      const { t } = useTranslation();
      return t(keyName);
    }
  `;
  const locale = { common: { allowed: "Allowed" }, feature: {} };
  withFixture(source, locale, (projectRoot) => {
    const failed = checkI18nUsage({ projectRoot, manifest: [] });
    assert.equal(failed.ok, false);
    assert.ok(failed.errors.some((error) => error.code === "DYNAMIC_KEY"));

    const passed = checkI18nUsage({
      projectRoot,
      manifest: [
        {
          selector: "src/fixture.tsx#keyName",
          keys: ["common:allowed"],
        },
      ],
    });
    assert.equal(passed.ok, true, JSON.stringify(passed.errors, null, 2));
  });
});

test("fails stale manifest selectors and wildcard keys", () => {
  const source = `
    import { useTranslation } from "react-i18next";
    export function View() {
      const { t } = useTranslation();
      return t("common:ready");
    }
  `;
  const locale = { common: { ready: "Ready" }, feature: {} };
  withFixture(source, locale, (projectRoot) => {
    const stale = checkI18nUsage({
      projectRoot,
      manifest: [
        { selector: "src/fixture.tsx#missing", keys: ["common:ready"] },
      ],
    });
    assert.ok(stale.errors.some((error) => error.code === "STALE_MANIFEST"));

    const wildcard = checkI18nUsage({
      projectRoot,
      manifest: [
        { selector: "src/fixture.tsx#missing", keys: ["common:*"] },
      ],
    });
    assert.ok(wildcard.errors.some((error) => error.code === "INVALID_MANIFEST"));
  });
});

test("missing keys fail even when t supplies a default value", () => {
  const source = `
    import { useTranslation } from "react-i18next";
    export function View() {
      const { t } = useTranslation();
      return t("common:missing", "Fallback");
    }
  `;
  withFixture(source, { common: {}, feature: {} }, (projectRoot) => {
    const report = checkI18nUsage({ projectRoot, manifest: [] });
    assert.ok(report.errors.some((error) => error.code === "MISSING_KEY"));
  });
});
