import { z } from 'zod';
import { idSchema } from './domain';
import { LOCAL_SUBTITLE_DEVICE_PREFERENCES } from './transcription/domain';

/** Recognizing a cue again with a local transcription model: limits and request shapes. */
export const CUE_RECOGNIZE_LIMITS = {
  /** Original audio kept on each side of the cue, so first and last words are not cut. */
  padMs: 200,
  /** The local server takes uploads up to 1 MiB: about 32 s of 16 kHz mono audio. */
  maxMs: 30_000,
  sampleRate: 16_000,
  /** Cues recognized in one go from the dialog. */
  batch: 20,
  promptChars: 200,
} as const;

const modelIdSchema = z.string().min(1).max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const languageSchema = z.union([z.literal('auto'), z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)]);
export const cueRecognizeRequestSchemas = {
  recognizeCue: z.object({
    documentId: idSchema, cueId: idSchema, modelId: modelIdSchema, language: languageSchema,
    /** The transcription setting: auto, cpu, cuda or metal. */
    devicePreference: z.enum(LOCAL_SUBTITLE_DEVICE_PREFERENCES).optional(),
    initialPrompt: z.string().trim().max(CUE_RECOGNIZE_LIMITS.promptChars).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)).optional(),
  }).strict(),
  cancelCueRecognition: z.object({}).strict(),
};
export type CueRecognizeRequest = z.infer<typeof cueRecognizeRequestSchemas.recognizeCue>;
/** What the model heard; empty when it heard no speech. */
export type CueRecognizeResult = { text: string; language?: string };
