import { BoundedCleanupRetryQueue } from "@/services/shared/boundedCleanupRetryQueue";
import type {
  LocalSubtitleAuthorizedMedia,
  LocalSubtitleOutputDirectorySelection,
  LocalSubtitleRendererApi,
} from "@/type/localSubtitleIpc";

const RETRY_DELAYS_MS = [250, 1_000, 5_000, 15_000, 60_000] as const;
const FALLBACK_TTL_MS = 30 * 60 * 1_000;
const ATTEMPT_TIMEOUT_MS = 5_000;

type ActiveOutputDirectory = Extract<
  LocalSubtitleOutputDirectorySelection,
  { cancelled: false }
>;

type CleanupRequest =
  | { readonly kind: "input"; readonly token: string }
  | { readonly kind: "output"; readonly token: string };

export interface LocalSubtitleCapabilityCleanupServiceOptions {
  readonly getApi: () => LocalSubtitleRendererApi;
  readonly retryDelaysMs?: readonly number[];
  readonly attemptTimeoutMs?: number;
  readonly now?: () => number;
}

export class LocalSubtitleCapabilityCleanupService {
  private readonly queue: BoundedCleanupRetryQueue<CleanupRequest>;

  constructor(options: LocalSubtitleCapabilityCleanupServiceOptions) {
    this.queue = new BoundedCleanupRetryQueue<CleanupRequest>({
      retryDelaysMs: options.retryDelaysMs ?? RETRY_DELAYS_MS,
      ttlMs: FALLBACK_TTL_MS,
      attemptTimeoutMs: options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS,
      expiryPolicy: "earliest",
      now: options.now,
      operation: async (request) => {
        const response =
          request.kind === "input"
            ? await options.getApi().revokeInputFile(request.token)
            : await options.getApi().revokeOutputDirectory(request.token);
        return (
          response.ok ||
          response.error.code === "owner_released" ||
          response.error.code === "authorization_expired"
        );
      },
    });
  }

  get pendingCount(): number {
    return this.queue.size;
  }

  queueInputDraftRevocation(
    media: Pick<LocalSubtitleAuthorizedMedia, "fileToken" | "expiresAt">,
  ): void {
    void this.queue.queue(
      `input:${media.fileToken}`,
      { kind: "input", token: media.fileToken },
      media.expiresAt,
    );
  }

  queueOutputDraftRevocation(
    output: Pick<ActiveOutputDirectory, "outputDirToken" | "expiresAt">,
  ): void {
    void this.queue.queue(
      `output:${output.outputDirToken}`,
      { kind: "output", token: output.outputDirToken },
      output.expiresAt,
    );
  }

  async flushPendingDraftRevocations(): Promise<void> {
    await this.queue.flush();
  }

  reset(): void {
    this.queue.reset();
  }
}
