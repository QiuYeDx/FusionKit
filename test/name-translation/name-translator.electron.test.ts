import { afterAll, describe, expect, it } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright/test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createChatCompletionBody,
  startFakeModelApiServer,
  type FakeModelApiServer,
} from "../ai/fakeModelApiServer";

const DICTIONARY: Record<string, string> = {
  アニメ資料: "Anime Materials",
  第1期: "Season 1",
  第1話: "Episode 1",
  第2話: "Episode 2",
  表紙: "Cover",
  メモ: "Notes",
  "とても長いファイル名のサンプルでツールチップと中間省略を確認するためのもの": "A very long sample file name used to check tooltips and middle ellipsis rendering",
};

async function tree(directory: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    result.push(entry.isDirectory() ? `${relative}/` : relative);
    if (entry.isDirectory()) result.push(...(await tree(path.join(directory, entry.name), relative)));
  }
  return result.sort();
}

async function waitForApp(page: Page) {
  await page.waitForFunction(
    () => !document.querySelector(".app-loading-wrap") && !document.querySelector("#app-loading-style"),
  );
}

describe.runIf(process.env.FUSIONKIT_NAME_TRANSLATOR_E2E === "1")("Name translator in Electron", () => {
  let app: ElectronApplication | undefined;
  let server: FakeModelApiServer | undefined;
  let root = "";
  let dataRoot = "";

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await server?.close().catch(() => undefined);
      if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (dataRoot) await rm(dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("translates a folder together with its contents, renames safely and undoes", async () => {
    root = await mkdtemp(path.join(tmpdir(), "fk-name-e2e-"));
    const artifacts = path.resolve("test-results/name-translator");
    await mkdir(artifacts, { recursive: true });
    // Keep fixtures outside %TEMP%: drops from there are treated as Explorer proxies.
    const data = path.resolve("test-results/name-translator-data");
    await rm(data, { recursive: true, force: true });
    dataRoot = data;
    const folder = path.join(data, "アニメ資料");
    await mkdir(path.join(folder, "第1期"), { recursive: true });
    await writeFile(path.join(folder, "第1期", "第1話.mp4"), "1");
    await writeFile(path.join(folder, "第1期", "第2話.mp4"), "2");
    await writeFile(path.join(folder, "表紙.jpg"), "cover");
    await writeFile(path.join(folder, "Cover.jpg"), "existing");
    await writeFile(path.join(folder, "メモ.txt"), "memo");
    await writeFile(path.join(folder, "2024-01-01.log"), "log");
    await writeFile(path.join(folder, "とても長いファイル名のサンプルでツールチップと中間省略を確認するためのもの.txt"), "long");
    await writeFile(path.join(data, "single.txt"), "single");
    const before = await tree(data);

    server = await startFakeModelApiServer();
    for (let index = 0; index < 20; index += 1) {
      server.enqueueRoute("chat_completions", (request) => {
        const messages = request.body.messages as { content: string }[];
        const input = JSON.parse(messages[1]!.content) as { items: { id: string; name: string }[] };
        return {
          body: createChatCompletionBody({
            content: JSON.stringify({
              items: input.items.map((item) => ({ id: item.id, name: DICTIONARY[item.name] ?? item.name })),
            }),
          }),
        };
      });
    }

    app = await electron.launch({
      args: [".", `--user-data-dir=${path.join(root, "profile")}`],
      cwd: process.cwd(),
      env: { ...process.env, VITE_DEV_SERVER_URL: "", NODE_ENV: "test" },
    });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await app.evaluate(({ dialog }, picked) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog;
    }, folder);

    await page.evaluate((baseUrl) => {
      localStorage.clear();
      localStorage.setItem("lang", "zh");
      localStorage.setItem("fusionkit-theme", JSON.stringify({ state: { theme: "light" }, version: 0 }));
      localStorage.setItem(
        "fusionkit-model",
        JSON.stringify({
          version: 5,
          state: {
            profiles: [
              {
                id: "name-e2e",
                name: "Name translator fixture",
                provider: "Other",
                apiKey: "name-e2e-placeholder",
                baseUrl,
                modelKey: "fake-chat-model",
                tokenPricing: { inputTokensPerMillion: 0, outputTokensPerMillion: 0 },
                apiFormat: "chat_completions",
                outputTokenParameter: "max_tokens",
              },
            ],
            assignment: { agent: null, taskExecution: "name-e2e" },
            audioProfiles: [],
            audioAssignment: { transcription: null, speechSynthesis: null, realtimeCaptions: null, realtimeVoice: null },
          },
        }),
      );
      location.hash = "/tools/rename/name-translator";
    }, server.baseUrl);
    await page.reload();
    await waitForApp(page);
    const window = await app.browserWindow(page);
    await window.evaluate((win) => win.setSize(1280, 860));
    await page.locator("[data-slot=tool-detail-layout]").waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(artifacts, "01-empty-1280-light.png") });

    // A native drop adds a file as a root entry; on Windows a drop from %TEMP% is refused.
    const dropFile = async (filePath: string) => {
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file";
      input.dataset.testid = "name-e2e-files";
      input.className = "sr-only";
      document.body.append(input);
    });
    await page.getByTestId("name-e2e-files").setInputFiles([filePath]);
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="name-e2e-files"]')!;
      const target = document.querySelector<HTMLElement>("#name-translator-entries")!;
      const transfer = new DataTransfer();
      for (const file of input.files ?? []) transfer.items.add(file);
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
      }
      input.remove();
    });
    };
    if (process.platform === "win32") {
      const proxy = path.join(root, "proxy.txt");
      await writeFile(proxy, "proxy");
      await dropFile(proxy);
      await page.getByText(/临时副本/).waitFor();
    }
    await dropFile(path.join(data, "single.txt"));
    await page.locator("[role=row][data-path$='single.txt']").waitFor();

    // Add the folder: it is selected itself and expanded one level.
    await page.getByRole("button", { name: "添加文件夹" }).first().click();
    const folderRow = page.locator(`[role=row][data-path="${folder.replace(/\\/g, "\\\\")}"]`);
    await folderRow.waitFor();
    await page.locator("[role=row][data-path]").nth(5).waitFor();

    // Select everything inside (recursive) with one click.
    await folderRow.hover();
    await folderRow.getByRole("button", { name: "选择内部全部" }).click();
    await page.getByText("内含 8/8 已选").waitFor();

    await page.getByRole("button", { name: /翻译 \d+ 项/ }).click();
    const renameButton = page.getByTestId("name-translator-rename");
    await renameButton.waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-status="translating"]'));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(artifacts, "02-translated-1280-light.png") });

    // Hover overlay of "select all inside" in both themes.
    await folderRow.hover();
    await page.waitForTimeout(250);
    const rowBox = (await folderRow.boundingBox())!;
    const clip = { x: rowBox.x, y: rowBox.y - 4, width: rowBox.width / 2 + 8, height: rowBox.height + 8 };
    await page.screenshot({ path: path.join(artifacts, "02b-hover-light.png"), clip });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(artifacts, "02c-hover-dark.png"), clip });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));

    // Name formats: bilingual presets and a custom template update names without translating again.
    const requestsBefore = server.requests.length;
    await page.getByRole("radio", { name: "双语" }).click();
    await page.locator("[role=row][data-path$='メモ.txt']").getByText("Notes (メモ).txt").waitFor();
    await page.getByRole("radio", { name: "自定义" }).click();
    const template = page.getByRole("textbox", { name: "自定义名称格式" });
    await template.fill("{original}");
    await page.getByText("格式中需要包含 {translated}").waitFor();
    expect(await renameButton.isDisabled()).toBe(true);
    await template.fill("[{original}] {translated}");
    await page.locator("[role=row][data-path$='メモ.txt']").getByText("[メモ] Notes.txt").waitFor();
    await page.getByText("示例：[第1話] 第1集.mp4").waitFor();
    await page.locator("aside").screenshot({ path: path.join(artifacts, "02d-custom-format.png") });
    await page.getByRole("radio", { name: "仅译名" }).click();
    await page.locator("[role=row][data-path$='メモ.txt']").getByText("Notes.txt").waitFor();
    expect(server.requests.length).toBe(requestsBefore);

    const statuses = await page.locator("[role=row][data-path] [data-status]").evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-status")),
    );
    expect(statuses).toContain("issue"); // 表紙.jpg -> Cover.jpg collides with the existing Cover.jpg
    expect(statuses).toContain("unchanged"); // 2024-01-01.log and Cover.jpg keep their names

    // Long names keep their tail visible and show the full name in a tooltip.
    const longRow = page.locator("[role=row][data-path$='確認するためのもの.txt']");
    await longRow.locator("[role=gridcell]").first().locator("span.flex").first().hover();
    await page.getByRole("tooltip").first().waitFor();
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(artifacts, "03-long-name-tooltip.png") });
    await page.mouse.move(5, 5);

    await renameButton.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(artifacts, "04-confirm-1280-light.png") });
    await page.getByTestId("name-translator-confirm").click();
    await page.getByTestId("name-translator-outcome").waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(artifacts, "05-renamed-1280-light.png") });

    expect(await tree(data)).toEqual(
      [
        "Anime Materials/",
        "Anime Materials/2024-01-01.log",
        "Anime Materials/A very long sample file name used to check tooltips and middle ellipsis rendering.txt",
        "Anime Materials/Cover.jpg",
        "Anime Materials/Notes.txt",
        "Anime Materials/Season 1/",
        "Anime Materials/Season 1/Episode 1.mp4",
        "Anime Materials/Season 1/Episode 2.mp4",
        "Anime Materials/表紙.jpg",
        "single.txt",
      ].sort(),
    );
    // The list now shows the renamed root; the skipped entry stays selected with its problem.
    await page.locator(`[role=row][data-path="${path.join(data, "Anime Materials").replace(/\\/g, "\\\\")}"]`).waitFor();
    const skipped = page.locator("[role=row][data-path$='表紙.jpg']");
    await skipped.locator("[data-status=issue]").waitFor();
    expect(await skipped.getAttribute("aria-selected")).toBe("true");
    await window.evaluate((win) => win.setSize(786, 660));
    await page.waitForTimeout(400);
    await page.getByTestId("name-translator-outcome").evaluate((element) => element.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(artifacts, "05b-renamed-786-light.png") });
    expect(
      await page
        .locator("[data-slot=tool-detail-layout], [data-slot=tool-detail-layout] main, [data-slot=tool-panel]")
        .evaluateAll((elements) => elements.every((element) => element.scrollWidth <= element.clientWidth + 1)),
    ).toBe(true);
    await window.evaluate((win) => win.setSize(1280, 860));

    await page.getByTestId("name-translator-outcome").getByRole("button", { name: "撤销" }).click();
    await page.getByText(/已撤销/).waitFor();
    expect(await tree(data)).toEqual(before);
    await page.locator(`[role=row][data-path="${folder.replace(/\\/g, "\\\\")}"]`).waitFor();

    // Visual checks in dark theme and the narrow window.
    await page.evaluate(() => localStorage.setItem("fusionkit-theme", JSON.stringify({ state: { theme: "dark" }, version: 0 })));
    await page.reload();
    await waitForApp(page);
    await window.evaluate((win) => win.setSize(786, 660));
    await page.locator("[data-slot=tool-detail-layout]").waitFor();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(artifacts, "06-after-undo-786-dark.png") });
    expect(
      await page
        .locator("[data-slot=tool-detail-layout], [data-slot=tool-detail-layout] main")
        .evaluateAll((elements) => elements.every((element) => element.scrollWidth <= element.clientWidth + 1)),
    ).toBe(true);
    expect(errors).toEqual([]);
  }, 180_000);
});
