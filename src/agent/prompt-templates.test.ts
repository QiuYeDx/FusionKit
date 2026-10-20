import { describe, expect, it } from "vitest";
import zh from "@/locales/zh/home.json";
import en from "@/locales/en/home.json";
import ja from "@/locales/ja/home.json";
import zhHant from "@/locales/zh-Hant/home.json";
import {
  defaultTemplateValues, findPromptTemplate, isFieldShown, missingTemplateFields, PROMPT_TEMPLATES, templatesForRoute, type TemplateValues,
} from "./prompt-templates";

/** A tiny i18next stand-in over one locale's home.json. */
function translator(resource: Record<string, unknown>) {
  return (key: string, options: Record<string, unknown> = {}) => {
    const value = key.replace(/^home:/, "").split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], resource);
    if (typeof value !== "string") throw new Error(`missing ${key}`);
    return value.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? `{{${name}}}`));
  };
}

describe("workflow templates", () => {
  it("build complete prompts for every agent they offer, in every language", () => {
    for (const resource of [zh, en, ja, zhHant]) {
      const t = translator(resource);
      for (const template of PROMPT_TEMPLATES) {
        for (const option of ["title", "summary", "description"]) expect(t(`home:templates.${template.id}.${option}`)).toBeTruthy();
        const values: TemplateValues = { ...defaultTemplateValues(template), path: "D:\\Music\\Live" };
        for (const target of template.targets) {
          const prompt = template.build(values, target, t);
          expect(prompt).toContain("D:\\Music\\Live");
          expect(prompt).not.toMatch(/\{\{\w+\}\}/);
        }
        // Every option label exists too.
        for (const field of template.fields) {
          t(field.labelKey);
          for (const option of field.options ?? []) t(option.labelKey);
        }
      }
    }
  });

  it("ask the user's transcription workflow the way they describe it", () => {
    const t = translator(zh);
    const template = findPromptTemplate("media_bilingual")!;
    const values = { ...defaultTemplateValues(template), path: "D:\\直播", spoken: "JA" };
    const prompt = template.build(values, "fusionkit", t);
    expect(prompt).toContain("说话语言：日语");
    expect(prompt).toContain("翻译成简体中文");
    expect(prompt).toContain("双语，译文在前");
    expect(prompt).toContain("自动（音频 LRC，视频 SRT）");
    expect(prompt).toContain("简体中文译名在前、原名在后，中间用 “ - ” 分隔");
    expect(template.build({ ...values, rename: false }, "fusionkit", t)).not.toContain("文件名翻译成双语");
    // The external agent gets the MCP tools to call, with their arguments.
    const external = template.build(values, "external", t);
    for (const tool of ["start_studio_transcription", "write_studio_translations", "export_studio_document", "rename_paths"]) expect(external).toContain(tool);
    expect(external).toContain("language=ja");
    expect(external).toContain("content=bilingual，order=target-first，format=auto");
  });

  it("need a folder, and show a gap in the prompt until there is one", () => {
    const t = translator(zh);
    const template = findPromptTemplate("convert_subtitles")!;
    const values = defaultTemplateValues(template);
    expect(missingTemplateFields(template, values)).toEqual(["path"]);
    expect(template.build(values, "fusionkit", t)).toContain("〈文件夹路径〉");
    expect(missingTemplateFields(template, { ...values, path: "  " })).toEqual(["path"]);
    expect(missingTemplateFields(template, { ...values, path: "D:\\subs" })).toEqual([]);
    expect(template.build({ ...values, path: "D:\\subs" }, "external", t)).toContain("to=lrc，recursive=true，conflict=indexed");
  });

  it("hide the name separator when only the translated name is kept", () => {
    const template = findPromptTemplate("bilingual_names")!;
    const separator = template.fields.find((field) => field.key === "separator")!;
    expect(isFieldShown(separator, { layout: "target_first" })).toBe(true);
    expect(isFieldShown(separator, { layout: "source_first" })).toBe(true);
    expect(isFieldShown(separator, { layout: "target_only" })).toBe(false);
  });

  it("offer the matching template first on each tool page", () => {
    expect(templatesForRoute("/tools/subtitle/converter").map((template) => template.id)).toEqual(["convert_subtitles"]);
    expect(templatesForRoute("/tools/subtitle/translator").map((template) => template.id)).toEqual(["translate_subtitles", "resume_translation"]);
    expect(templatesForRoute("/setting")).toEqual([]);
  });
});
