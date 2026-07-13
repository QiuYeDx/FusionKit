# FK-PIT-0007: Keep preload-internal IPC out of public invoke bridges

## Area

Electron preload security / contextBridge IPC capability boundaries.

## Triggers

contextBridge, generic invoke, internal IPC, preload-only channel, file token, capability bypass

## Symptoms

- A typed renderer API appears to expose only public channels, but runtime JavaScript can pass an internal channel string.
- A preload convenience method validates a `File` or opens a native dialog, while the generic public `invoke` can call the same main handler with forged raw paths.
- Main validates a capability envelope but cannot prove that an internal payload came from the intended preload-only operation.

## Root cause

TypeScript channel unions do not enforce runtime boundaries. When a generic bridge and preload-only helpers share a low-level invoke function, allowing internal channels in that shared function also allows compromised renderer code to call them through the public generic method.

## Do

- Validate public generic invocations against an exact allowlist built from public channel constants.
- Keep the capability-envelope sender in a preload-private low-level closure.
- Let only dedicated preload methods call fixed internal channel constants.
- Keep the legacy exposed `ipcRenderer` bridge rejecting every protected namespace channel.
- Add a pure policy test proving every public channel is allowed and every internal or prefix-confusable channel is rejected.

## Avoid

- Do not rely on a TypeScript union to reject a runtime string from renderer code.
- Do not use `startsWith("audio:")` or a similar namespace prefix as the public allowlist.
- Do not add internal exceptions to the same validation branch used by a contextBridge-exposed generic `invoke`.
- Do not treat a valid preload capability envelope as proof that the renderer used the intended convenience method.

## Validation

```text
node_modules/.bin/vitest run test/audio/audioPreloadChannelPolicy.test.ts test/audio/audioIpcService.test.ts
node_modules/.bin/tsc --noEmit
git diff --check
```

Confirm that `audioApi.invoke("audio:internal:authorize-input-file", ...)` is rejected by policy while `audioApi.authorizeInputFile(File)` still reaches the fixed internal handler through a private preload closure.

## Related files

- `electron/preload/index.ts`
- `electron/preload/audio-channel-policy.ts`
- `src/type/audioIpc.ts`
- `electron/main/audio/ipc.ts`
- `test/audio/audioPreloadChannelPolicy.test.ts`
