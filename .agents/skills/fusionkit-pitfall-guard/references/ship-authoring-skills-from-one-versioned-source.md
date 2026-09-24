# FK-PIT-0181: Ship authoring skills from one versioned source

## Area
Translation knowledge / skill distribution / build consistency.

## Triggers
Project skill path, downloadable skill, portable validator, stale examples, CRLF archive drift, protocol versus runtime support.

## Symptoms
A skill outside the discoverable project path drifts from the app; a downloadable copy can keep old instructions or omit its validator. Matching the JSON Schema alone does not prove that documented types participate in translation.

## Root cause
Authoring guidance, generated protocol files and the user-facing download are maintained independently. Byte comparisons of source text also depend on Git checkout line endings.

## Do
- Keep a single source in .agents/skills; move callers and examples with it instead of retaining a legacy copy.
- Generate the offline archive from an explicit portable file list. Include referenced instructions, examples, Schema and the bundled validator.
- Normalize text line endings and fixed ZIP metadata; gate builds on parity with the source and current protocol modules.
- Document execution support, task selection and local review separately from schema support. Candidate packs use the actual batch review UI, not fabricated approvals.
- Test the extracted validator outside the repository, references within the archive, Japanese matching and native save/cancel/failure without library mutation.

## Avoid
Do not ship only SKILL.md, invent imported provider settings, grant trust through downloaded metadata, or read arbitrary renderer paths to choose skill contents.

## Validation
Run knowledge:check, protocol/ipc/skill-archive tests and the isolated skill-download-electron test; review screenshots and close owned processes.

## Related files
- .agents/skills/fusionkit-translation-knowledge/
- scripts/translation-knowledge/build-artifacts.mjs
- scripts/translation-knowledge/skill-archive.mjs
- src/pages/TranslationKnowledge/KnowledgeSkillDownload.tsx
- test/translation-knowledge/skill-archive.test.ts
