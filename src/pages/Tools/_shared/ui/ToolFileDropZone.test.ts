import { describe, expect, it, vi } from "vitest";
import { consumeToolFileInputSelection } from "./ToolFileDropZone";

describe("consumeToolFileInputSelection", () => {
  it("retains native File authority until asynchronous authorization settles", async () => {
    const files = { length: 1 } as FileList;
    let inputValue = "C:\\fakepath\\sample.wav";
    let releaseAuthorization!: () => void;
    const authorization = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    const input = {
      get files() {
        return files;
      },
      get value() {
        return inputValue;
      },
      set value(nextValue: string) {
        inputValue = nextValue;
      },
    } as Pick<HTMLInputElement, "files" | "value">;
    const onFiles = vi.fn(async (selected: FileList) => {
      expect(selected).toBe(files);
      expect(inputValue).not.toBe("");
      await authorization;
      expect(inputValue).not.toBe("");
    });

    const pending = consumeToolFileInputSelection(input, onFiles);
    expect(onFiles).toHaveBeenCalledOnce();
    expect(inputValue).not.toBe("");

    releaseAuthorization();
    await pending;
    expect(inputValue).toBe("");
  });

  it("clears the picker after a rejected consumer without masking its error", async () => {
    const files = { length: 1 } as FileList;
    let inputValue = "C:\\fakepath\\sample.wav";
    const input = {
      files,
      get value() {
        return inputValue;
      },
      set value(nextValue: string) {
        inputValue = nextValue;
      },
    } as Pick<HTMLInputElement, "files" | "value">;
    const failure = new Error("authorization failed");

    await expect(
      consumeToolFileInputSelection(input, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(inputValue).toBe("");
  });
});
