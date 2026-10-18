import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { classifyUpdateError, describeUpdateError, mostTellingFailure } from '../../electron/main/app-update/errors';

const require = createRequire(import.meta.url);
const runtime = require('builder-util-runtime') as {
  HttpError: new (status: number, message?: string) => Error;
  CancellationError: new () => Error;
  newError(message: string, code: string): Error;
};
const coded = (message: string, code: string) => Object.assign(new Error(message), { code });

describe('update error classification', () => {
  it('treats connection failures as "network", as the network layer classifies them', () => {
    expect(classifyUpdateError(new Error('net::ERR_CONNECTION_TIMED_OUT'))).toEqual({ kind: 'network', networkCategory: 'timeout' });
    expect(classifyUpdateError(new Error('net::ERR_NAME_NOT_RESOLVED'))).toEqual({ kind: 'network', networkCategory: 'dns' });
    expect(classifyUpdateError(new Error('net::ERR_PROXY_CONNECTION_FAILED'))).toEqual({ kind: 'network', networkCategory: 'proxy_failed' });
    expect(classifyUpdateError(coded('getaddrinfo ENOTFOUND github.com', 'ENOTFOUND'))).toEqual({ kind: 'network', networkCategory: 'dns' });
    expect(classifyUpdateError(new Error('Request timed out'))).toMatchObject({ kind: 'network' });
    expect(classifyUpdateError(new Error('Request has been aborted by the server'))).toMatchObject({ kind: 'network' });
    expect(classifyUpdateError(new Error('socket hang up'))).toMatchObject({ kind: 'network', networkCategory: 'reset' });
    // GitHub's own wrapper around a connection failure is still a connection failure.
    expect(classifyUpdateError(runtime.newError('Unable to find latest version on GitHub (…): net::ERR_CONNECTION_RESET', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND')))
      .toEqual({ kind: 'network', networkCategory: 'reset' });
  });

  it('maps HTTP answers: missing files, busy sources and the rest', () => {
    expect(classifyUpdateError(new runtime.HttpError(404, '404 Not Found\nHeaders: {}'))).toEqual({ kind: 'not_found', status: 404 });
    expect(classifyUpdateError(new runtime.HttpError(503))).toEqual({ kind: 'network', status: 503 });
    expect(classifyUpdateError(new runtime.HttpError(429))).toEqual({ kind: 'network', status: 429 });
    expect(classifyUpdateError(new runtime.HttpError(407))).toMatchObject({ kind: 'network', networkCategory: 'proxy_auth' });
    expect(classifyUpdateError(new runtime.HttpError(400))).toEqual({ kind: 'unknown', status: 400 });
    // electron-updater's download error has no status field, only its message.
    expect(classifyUpdateError(new Error('Cannot download "https://ghfast.top/https://github.com/a/b/releases/download/v1/x.exe", status 404: Not Found')))
      .toEqual({ kind: 'not_found', status: 404 });
    expect(classifyUpdateError(runtime.newError('Cannot find channel "latest.yml" update info', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'))).toEqual({ kind: 'not_found' });
  });

  it('treats unusable update information as a source that did not get through', () => {
    for (const code of ['ERR_UPDATER_INVALID_UPDATE_INFO', 'ERR_UPDATER_NO_FILES_PROVIDED', 'ERR_UPDATER_NO_CHECKSUM', 'ERR_UPDATER_INVALID_VERSION']) {
      expect(classifyUpdateError(runtime.newError('bad', code))).toEqual({ kind: 'network' });
    }
  });

  it('recognises a SHA-512 mismatch, a full or protected disk and a cancel', () => {
    expect(classifyUpdateError(runtime.newError('sha512 checksum mismatch, expected a, got b', 'ERR_CHECKSUM_MISMATCH'))).toEqual({ kind: 'checksum' });
    expect(classifyUpdateError(new Error('sha512 checksum mismatch, expected a, got b'))).toEqual({ kind: 'checksum' });
    expect(classifyUpdateError(coded('ENOSPC: no space left on device, write', 'ENOSPC'))).toEqual({ kind: 'disk' });
    expect(classifyUpdateError(coded("EPERM: operation not permitted, rename 'a' -> 'b'", 'EPERM'))).toEqual({ kind: 'disk' });
    expect(classifyUpdateError(new runtime.CancellationError())).toEqual({ kind: 'cancelled' });
    expect(classifyUpdateError(new Error('Something else'))).toEqual({ kind: 'unknown' });
    expect(classifyUpdateError(Object.assign(new Error('wrapped'), { cause: coded('connect ECONNREFUSED 127.0.0.1:443', 'ECONNREFUSED') })))
      .toEqual({ kind: 'network', networkCategory: 'refused' });
  });

  it('reports the answer that says most once every source failed, github.com first', () => {
    const network = { kind: 'network', networkCategory: 'timeout' } as const;
    const notFound = { kind: 'not_found', status: 404 } as const;
    // The release files are still uploading: GitHub and a mirror say so, the last mirror times out.
    expect(mostTellingFailure([{ official: true, failure: notFound }, { official: false, failure: notFound }, { official: false, failure: network }]))
      .toEqual(notFound);
    expect(mostTellingFailure([{ official: true, failure: network }, { official: false, failure: notFound }])).toEqual(notFound);
    // A file that failed its check, from github.com, outweighs a mirror's 404.
    expect(mostTellingFailure([{ official: false, failure: notFound }, { official: true, failure: { kind: 'checksum' } }])).toEqual({ kind: 'checksum' });
    // "Network" only when nothing answered like that, and an odd error does not hide it.
    expect(mostTellingFailure([{ official: true, failure: network }, { official: false, failure: { kind: 'network', status: 503 } }, { official: false, failure: { kind: 'unknown' } }]))
      .toEqual({ kind: 'network', status: 503 });
    expect(mostTellingFailure([{ official: true, failure: { kind: 'unknown', status: 400 } }])).toEqual({ kind: 'unknown', status: 400 });
    expect(mostTellingFailure([])).toBeUndefined();
  });

  it('keeps the copyable detail short and free of signed links, headers and file contents', () => {
    expect(describeUpdateError(new runtime.HttpError(404, '404 Not Found\nHeaders: {"set-cookie":"secret"}'))).toBe('HTTP 404');
    expect(describeUpdateError(new Error('Cannot download "https://release-assets.githubusercontent.com/x?sig=SECRET&se=1", status 503: Busy'))).toBe('HTTP 503');
    expect(describeUpdateError(runtime.newError('Cannot parse update info from latest.yml in the latest release artifacts (https://x/latest.yml?noCache=1): bad, rawData: <html>', 'ERR_UPDATER_INVALID_UPDATE_INFO')))
      .toBe('ERR_UPDATER_INVALID_UPDATE_INFO · Cannot parse update info from latest.yml in the latest release artifacts (https://x/latest.yml): bad');
    expect(describeUpdateError(new Error('net::ERR_CONNECTION_RESET at https://github.com/a?token=SECRET'))).toBe('net::ERR_CONNECTION_RESET at https://github.com/a');
    expect(describeUpdateError(new Error('x'.repeat(500)))).toHaveLength(240);
    expect(describeUpdateError('plain')).toBe('plain');
  });
});
