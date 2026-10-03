# FK-PIT-0184: Keep rendered agent history separate from execution authority

## Area

HomeAgent / Markdown widgets / confirmation scope

## Triggers

pending-execution, widgetContext, imported history, model-generated card, confirmation, current pending task, rename plan

## Symptoms

An imported or model-generated pending-execution card may describe one file while its confirm button starts a different current queue. A natural-language denial such as “我还没确认执行这个重命名计划” may also match a keyword-based confirmation parser.

## Root cause

HomeAgent passed the same executable widget context to untrusted conversation Markdown and the trusted store-derived pending card. The shared callback ignored the rendered payload and operated on whichever pending batch was current. Presence of action words in a sentence likewise did not establish affirmative user intent.

## Do

- Treat conversation text, imported cards and model-generated widget payloads as display data. Give execution callbacks only to a trusted component derived from current store state; when sharing renderers, separate read-only and executable contexts explicitly.
- Bind the confirmation to the actual current action identity/session and frozen task references. Claim synchronously before awaiting or admitting work; old results must not overwrite a replacement action.
- For rename confirmation through text, accept a complete short affirmative command and reject negations, conditions, quoted examples, questions and narrative mentions. Offer the trusted plan button when wording is ambiguous.
- Keep admitted receipts after interruption, but check session identity again after asynchronous cleanup before appending logs or updating pending state.

## Avoid

- Do not let a Markdown payload call a global “confirm current pending” handler.
- Do not infer approval from the presence of “确认/执行/apply/confirm”, or use a short blacklist as the entire authority test.
- Do not repair the problem by making imports auto-execute or by trusting card counts instead of task identities.

## Validation

- Render a historical pending card while a different real pending batch exists: historical confirm/cancel must have no execution authority; the trusted current card may confirm once.
- Test negative, conditional, quoted and past-tense confirmation text alongside accepted short commands.
- Delay recovery scan cleanup, reset the session, then resolve cleanup: new session receives no old log or pending execution, while the tool receipt retains admitted IDs.
- Run Agent/store tests and the isolated Electron HomeAgent QA; use the final build and await local composer geometry before taking screenshots.

## Related files

- `src/pages/HomeAgent/index.tsx`
- `src/agent/name-plan-confirmation.ts`
- `src/agent/name-plan-confirmation.test.ts`
- `src/agent/tool-executor.ts`
- `src/agent/tool-executor-translation.test.ts`
- `src/store/agent/useAgentStore.ts`
- `scripts/home-agent-qa.mjs`
- Related: FK-PIT-0163 (session claims and current draft identity)
