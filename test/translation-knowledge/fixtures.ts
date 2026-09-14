import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { KnowledgePackage } from '../../src/translation-knowledge/schemas'

export const exampleDirectory = fileURLToPath(new URL('../../skills/fusionkit-translation-knowledge/examples/', import.meta.url))
export function knowledgeFixture(): KnowledgePackage {
  return JSON.parse(readFileSync(`${exampleDirectory}/multi-subject.fktk.json`, 'utf8')) as KnowledgePackage
}
export const createKnowledgePackage = knowledgeFixture
