import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_UPDATE_ERROR_KINDS, type AppUpdateError } from "@/app-update/contract";
import { formatUpdateBytes, UPDATE_HELP_PATH, UPDATE_MAC_HELP_PATH, updateErrorGuide, updateSourceLabel } from "./update-guide";
import { changelogBetween, fetchChangelogMarkdown, parseChangelog } from "./useChangelog";

const zh = JSON.parse(readFileSync("src/locales/zh/common.json", "utf8"));
const lookup = (key: string) => key.replace(/^common:/, "").split(".").reduce<unknown>((value, part) => (value as Record<string, unknown> | undefined)?.[part], zh);
const failure = (kind: AppUpdateError["kind"], during: AppUpdateError["during"], mirrorsTried = true): AppUpdateError => ({ kind, during, mirrorsTried, detail: "x" });

describe("update error guide", () => {
  it("says a failed check is the network and offers the network settings", () => {
    const guide = updateErrorGuide(failure("network", "check"));
    expect(lookup(guide.titleKey)).toBe("检查更新失败");
    expect(lookup(guide.causeKey)).toBe("网络不通：连不上 GitHub，国内镜像也没有回应。");
    expect(lookup(guide.nextKey)).toBe("可以稍后再试，或在“网络”设置中换下载源、开代理。");
    expect(guide.actions).toEqual(["retry", "open_network_settings", "open_help"]);
    expect(lookup(updateErrorGuide(failure("network", "check", false)).causeKey)).toContain("只用官方下载源");
    expect(updateErrorGuide(failure("network", "download")).nextKey).toBe("common:update.error.network_next_download");
  });

  it("gives every kind and step a cause, a next step and at least one button, in Chinese", () => {
    for (const during of ["check", "download", "install"] as const) {
      for (const kind of APP_UPDATE_ERROR_KINDS) {
        const guide = updateErrorGuide(failure(kind, during));
        for (const key of [guide.titleKey, guide.causeKey, guide.nextKey]) expect(typeof lookup(key), key).toBe("string");
        expect(guide.actions.length).toBeGreaterThan(0);
      }
    }
    expect(updateErrorGuide(failure("checksum", "download")).actions).toEqual(["retry", "open_network_settings", "open_releases", "open_help"]);
    // A protected or locked file is not only a full disk: the manual download stays open.
    expect(updateErrorGuide(failure("disk", "download")).actions).toEqual(["retry", "open_releases"]);
    expect(lookup(updateErrorGuide(failure("disk", "download")).nextKey)).toContain("杀毒软件");
    expect(updateErrorGuide(failure("not_found", "check")).actions[0]).toBe("open_releases");
    expect(updateErrorGuide(failure("network", "install")).causeKey).toBe("common:update.error.install_cause");
  });

  it("leads a failed install to a restart, since FusionKit already stopped its services", () => {
    const started = updateErrorGuide({ ...failure("unknown", "install"), installStage: "start" });
    expect(started.actions).toEqual(["restart_app", "open_releases"]);
    expect(lookup(started.causeKey)).toBe("安装程序没有启动。");
    expect(lookup(started.nextKey)).toContain("重启 FusionKit");
    const prepare = updateErrorGuide({ ...failure("unknown", "install"), installStage: "prepare" });
    expect(prepare.actions).toEqual(["restart_app", "retry", "open_releases"]);
    expect(lookup(prepare.causeKey)).toContain("没能先停下");
    expect(lookup("common:update.restart_app")).toBe("重启 FusionKit");
  });

  it("adds the mirror link to the installer next to the download page, but not for a failed check", () => {
    expect(updateErrorGuide(failure("checksum", "download"), { mirrorDownload: true }).actions)
      .toEqual(["retry", "open_network_settings", "open_releases", "open_mirror_download", "open_help"]);
    expect(updateErrorGuide({ ...failure("unknown", "install"), installStage: "start" }, { mirrorDownload: true }).actions)
      .toEqual(["restart_app", "open_releases", "open_mirror_download"]);
    expect(updateErrorGuide(failure("not_found", "check"), { mirrorDownload: true }).actions).toEqual(["open_releases", "retry"]);
    // A download that lost the network can be finished by hand: the download page and the mirror installer.
    expect(updateErrorGuide(failure("network", "download")).actions).toEqual(["retry", "open_network_settings", "open_releases", "open_help"]);
    expect(updateErrorGuide(failure("network", "download"), { mirrorDownload: true }).actions)
      .toEqual(["retry", "open_network_settings", "open_releases", "open_mirror_download", "open_help"]);
    expect(updateErrorGuide(failure("network", "check"), { mirrorDownload: true }).actions).toEqual(["retry", "open_network_settings", "open_help"]);
    expect(lookup("common:update.open_releases")).toBe("打开下载页面");
  });

  it("links network and integrity failures to the help on downloads, and the macOS note to the help on opening the app", () => {
    expect(UPDATE_HELP_PATH).toBe("/help?section=download-failed");
    expect(UPDATE_MAC_HELP_PATH).toBe("/help?section=cannot-open");
    expect(updateErrorGuide(failure("disk", "download")).actions).not.toContain("open_help");
    expect(updateErrorGuide({ ...failure("unknown", "install"), installStage: "start" }).actions).not.toContain("open_help");
    expect(lookup("common:update.open_help")).toBe("查看帮助");
  });

  it("names the download source and formats sizes", () => {
    expect(updateSourceLabel("official")).toEqual({ key: "common:update.source_official" });
    expect(updateSourceLabel("ghfast")).toEqual({ key: "common:update.source_mirror", host: "ghfast.top" });
    expect(updateSourceLabel("ghproxy").host).toBe("ghproxy.net");
    expect(formatUpdateBytes(297_080_984)).toBe("283 MB");
    expect(formatUpdateBytes(18_731_856)).toBe("17.9 MB");
    expect(formatUpdateBytes(512)).toBe("512 B");
    expect(formatUpdateBytes(1.5 * 1024 ** 3)).toBe("1.50 GB");
    expect(formatUpdateBytes(Number.NaN)).toBe("-");
  });
});

const CHANGELOG = [
  "# Changelog", "", "## [0.5.2] - 2026-10-20", "", "### 修复", "- 更新可以在应用内安装", "",
  "## [0.5.1] - 2026-10-17", "", "- 外部 Agent 权限", "", "## [0.5.0] - 2026-10-15", "- 旧内容",
].join("\r\n");

describe("changelog", () => {
  it("reads the entries between the running and the new version", () => {
    const entries = changelogBetween(parseChangelog(CHANGELOG), "0.5.0", "0.5.2");
    expect(entries.map(entry => entry.version)).toEqual(["0.5.2", "0.5.1"]);
    expect(entries[0]).toEqual({ version: "0.5.2", date: "2026-10-20", sections: [{ title: "修复", items: ["更新可以在应用内安装"] }] });
    expect(entries[1]!.sections).toEqual([{ items: ["外部 Agent 权限"] }]);
  });

  it("tries the next address when one fails, times out or serves something else", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      asked.push(url);
      if (url.includes("raw")) throw new TypeError("Failed to fetch");
      if (url.includes("cdn")) return new Response("<html>busy</html>", { status: 200 });
      if (url.includes("fastly")) {
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }
      return new Response(CHANGELOG, { status: 200 });
    }) as typeof fetch;
    const urls = ["https://raw/x", "https://cdn/x", "https://fastly/x", "https://ghfast/x"];
    expect(await fetchChangelogMarkdown(urls, fetchImpl, 50)).toBe(CHANGELOG);
    expect(asked).toEqual(urls);
    await expect(fetchChangelogMarkdown(["https://raw/x"], fetchImpl, 50)).rejects.toThrow("Failed to fetch");
    const notFound = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchChangelogMarkdown(["https://ghfast/x"], notFound, 50)).rejects.toThrow("HTTP 404");
  });
});
