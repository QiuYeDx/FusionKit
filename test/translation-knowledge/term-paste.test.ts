import { describe, expect, it } from "vitest";
import { parseTermPaste, pastedTermProblem } from "../../src/pages/TranslationKnowledge/term-paste";

describe("everyday term paste", () => {
  it("preserves spaces within source phrases and parses table notes", () => {
    expect(parseTermPaste("checkpoint\t存档点\r\nsave slot\t存档槽\t游戏用语\r\n")).toEqual({ ok: true, rows: [
      { source: "checkpoint", target: "存档点", note: "" },
      { source: "save slot", target: "存档槽", note: "游戏用语" },
    ] });
    expect(parseTermPaste("save slot 存档槽")).toEqual({ ok: false, problem: "columns" });
  });
  it("reads CSV escaping, multiline cells and BOM without dropping a real first row", () => {
    expect(parseTermPaste('\uFEFF"say ""hi""","你好,朋友","line one\nline two"\n')).toEqual({ ok: true, rows: [
      { source: 'say "hi"', target: "你好,朋友", note: "line one\nline two" },
    ] });
    expect(parseTermPaste("source,target\nhello,你好", "comma", true)).toEqual({ ok: true, rows: [{ source: "hello", target: "你好", note: "" }] });
    expect(parseTermPaste("source,target", "comma", false)).toEqual({ ok: true, rows: [{ source: "source", target: "target", note: "" }] });
  });
  it("keeps incomplete cells for correction and rejects malformed or ambiguous rows", () => {
    expect(parseTermPaste("hello,\n,你好")).toEqual({ ok: true, rows: [
      { source: "hello", target: "", note: "" }, { source: "", target: "你好", note: "" },
    ] });
    expect(pastedTermProblem({ source: " ", target: "x", note: "" })).toBe("required");
    for (const value of ['"unterminated,x', '"closed"junk,x', 'a,b"c']) expect(parseTermPaste(value)).toEqual({ ok: false, problem: "format" });
    expect(parseTermPaste("a,b\n\nc,d")).toEqual({ ok: false, problem: "columns" });
    expect(parseTermPaste("a,b,c,d")).toEqual({ ok: false, problem: "columns" });
  });
  it("bounds rows and UTF-8 payloads before submission", () => {
    expect(parseTermPaste(Array.from({ length: 500 }, () => "a,b").join("\n")).ok).toBe(true);
    expect(parseTermPaste(Array.from({ length: 501 }, () => "a,b").join("\n"))).toEqual({ ok: false, problem: "limit" });
    expect(parseTermPaste("界".repeat(400_000))).toEqual({ ok: false, problem: "limit" });
    expect(pastedTermProblem({ source: "界".repeat(11_000), target: "x", note: "" })).toBe("limit");
  });
});
