import { SubtitleFileType, SubtitleTranslatorTask } from "./typing";
import { LRCTranslator } from "./class/lrc-translator";
import { SRTTranslator } from "./class/srt-translator";

export class TranslationService {
  private activeTasks = new Map<string, AbortController>();

  async processTask(task: SubtitleTranslatorTask) {
    const controller = new AbortController();
    this.activeTasks.set(task.fileName, controller);

    try {
      const translator = this.getTranslator(
        task.fileName.split(".").at(-1)?.toUpperCase() as SubtitleFileType,
        {
          apiKey: task.apiKey,
          apiModel: task.apiModel,
          endpoint: task.endPoint,
        }
      );
      console.info(">>> [processTask] task: ", task, translator);
      await translator.translate(task, controller.signal);
      return { status: "completed" };
    } catch (error) {
      if (error.name === "AbortError") return { status: "cancelled" };
      return { status: "failed", error: error.message };
    } finally {
      this.activeTasks.delete(task.fileName);
    }
  }

  private getTranslator(
    fileType: SubtitleFileType,
    params: { apiKey: string; apiModel: string; endpoint: string }
  ) {
    return {
      [SubtitleFileType.LRC]: new LRCTranslator({
        apiKey: params.apiKey,
        endpoint: params.endpoint,
        apiModel: params.apiModel,
      }),
      [SubtitleFileType.SRT]: new SRTTranslator({
        apiKey: params.apiKey,
        endpoint: params.endpoint,
        apiModel: params.apiModel,
      }),
    }[fileType];
  }

  cancelTask(fileName: string) {
    this.activeTasks.get(fileName)?.abort();
  }
}
