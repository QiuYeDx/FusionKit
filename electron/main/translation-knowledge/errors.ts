import type { KnowledgeErrorCode } from '../../../src/translation-knowledge/ipc-contract';
import type { Diagnostic } from '../../../src/translation-knowledge/validation';

export class KnowledgeServiceError extends Error {
  constructor(public readonly code: KnowledgeErrorCode, public readonly diagnostics: Diagnostic[] = []) {
    super(code);
    this.name = 'KnowledgeServiceError';
  }
}

export const diagnostic = (code: string, message: string, path = '$'): Diagnostic => ({ code, message, path });
