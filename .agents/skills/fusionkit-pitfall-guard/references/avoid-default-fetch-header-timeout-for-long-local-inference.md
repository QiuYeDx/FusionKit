# FK-PIT-0028: Avoid default fetch header timeout for long local inference

## Area

Local inference / Node HTTP lifecycle

## Triggers

whisper-server,fetch,Undici,headers timeout,5 minutes,long media,request_failed

## Symptoms

Node fetch can abort a healthy long-running local inference before response headers arrive; use an explicit long-task HTTP transport and test beyond five minutes.

## Root cause

Node's global `fetch` is implemented by Undici and carries a response-header
timeout that is easy to miss in a local-process integration. The official
`whisper-server` does not send inference response headers until transcription
finishes. A CPU request that needs more than roughly five minutes can therefore
fail in Node even though the child process is still computing normally. Short
samples and fast GPU runs never cross the boundary, so they falsely suggest the
transport is suitable for arbitrary long media.

## Do

- Use a streaming `node:http`/`node:https` multipart client, or an explicitly
  configured Undici dispatcher, for long local inference requests.
- Give inference its own deliberate, long but finite timeout; keep short health
  and startup timeouts separate.
- Stream the media file instead of buffering it, bound the response size, keep
  AbortSignal cancellation, and validate HTTP status plus structured JSON.
- On a transport failure, inspect the owned child exit state and bounded
  diagnostics before classifying it as runtime crash or OOM.
- Include at least one real request whose response headers arrive after five
  minutes, in addition to fast unit tests for multipart framing and cancellation.

## Avoid

- Do not use global `fetch` defaults for an inference whose duration can exceed
  ordinary web-request timeouts.
- Do not retry immediately while the original server computation may still be
  running; abort or restart at a controlled generation boundary first.
- Do not label a repeatable five-minute client disconnect as model OOM, server
  instability, or CPU-backend failure without checking transport timing.
- Do not fix the timeout by reading a multi-gigabyte media file into one Buffer.

## Validation

```text
node --test scripts/local-subtitle/whisper-server/*.test.mjs
node scripts/local-subtitle/whisper-server/run-poc.mjs <ignored local arguments>
git diff --check
```

Confirm a real CPU inference that produces no response headers for more than
five minutes completes, its SRT/LRC artifacts parse back, cancellation still
settles, response/diagnostics remain bounded, and shutdown leaves no child or
temporary directory.

## Related files

- `scripts/local-subtitle/whisper-server/supervisor.mjs`
- `scripts/local-subtitle/whisper-server/supervisor.test.mjs`
- `scripts/local-subtitle/whisper-server/run-poc.mjs`
- `docs/v0.2.11/local-subtitle-transcriber/fix/2026-07-17_local-subtitle-transcriber_avoid-fetch-header-timeout.md`
