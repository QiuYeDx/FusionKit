import { promises as fs } from "fs";
import type {
  CheckRenameTargetPathsParams,
  CheckRenameTargetPathsResult,
} from "./types";

const DEFAULT_PATH_CHECK_CONCURRENCY = 64;

type StatPath = (targetPath: string) => Promise<unknown>;

export interface CheckRenameTargetPathsDeps {
  stat?: StatPath;
}

export async function checkRenameTargetPaths(
  params: CheckRenameTargetPathsParams,
  deps: CheckRenameTargetPathsDeps = {}
): Promise<CheckRenameTargetPathsResult> {
  const stat = deps.stat ?? fs.stat;
  const paths = [...new Set((params.paths ?? []).filter(isNonEmptyString))];
  const concurrency = normalizeConcurrency(
    params.concurrency ?? DEFAULT_PATH_CHECK_CONCURRENCY,
    paths.length
  );
  const existingPaths: string[] = [];
  const errors: CheckRenameTargetPathsResult["errors"] = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= paths.length) return;

      const targetPath = paths[index];
      try {
        await stat(targetPath);
        existingPaths.push(targetPath);
      } catch (error) {
        if (!isMissingPathError(error)) {
          errors.push({
            path: targetPath,
            message: formatPathCheckError(error),
          });
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    existingPaths,
    errors,
  };
}

function normalizeConcurrency(value: number, total: number): number {
  if (total <= 0) return 0;
  if (!Number.isFinite(value)) return Math.min(DEFAULT_PATH_CHECK_CONCURRENCY, total);
  return Math.max(1, Math.min(total, Math.floor(value)));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function formatPathCheckError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
