import { createHash, createPublicKey, createVerify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { FFMPEG_SOURCE_RELEASE } from './ffmpeg-source-release.mjs';

// This is a fixed release verifier, not a general OpenPGP implementation. Exact
// archive, signature and key pins establish trust; Node/OpenSSL verifies RSA.
export async function verifyPinnedFfmpegSignature(options) {
  const [archive, signature, publicKey] = await Promise.all([
    readFile(options.archivePath), readFile(options.signaturePath), readFile(options.publicKeyPath),
  ]);
  for (const [bytes, size, hash] of [
    [archive, FFMPEG_SOURCE_RELEASE.archiveByteSize, FFMPEG_SOURCE_RELEASE.archiveSha256],
    [signature, FFMPEG_SOURCE_RELEASE.signatureByteSize, FFMPEG_SOURCE_RELEASE.signatureSha256],
    [publicKey, FFMPEG_SOURCE_RELEASE.publicKeyByteSize, FFMPEG_SOURCE_RELEASE.publicKeySha256],
  ]) {
    if (bytes.length !== size || createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('FFmpeg source input does not match its fixed pin.');
  }
  verifyRsaBinaryDocument({ archive, signature, publicKey, fingerprint: FFMPEG_SOURCE_RELEASE.signingKeyFingerprint });
  return { status: 'verified', fingerprint: FFMPEG_SOURCE_RELEASE.signingKeyFingerprint, verifier: 'node_crypto_openpgp_v4_rsa_sha512' };
}

function armor(bytes, kind) {
  const text = bytes.toString('ascii').trim();
  const prefix = `-----BEGIN PGP ${kind}-----`, suffix = `-----END PGP ${kind}-----`;
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) throw new Error('Unexpected OpenPGP armor.');
  const lines = text.slice(prefix.length, -suffix.length).trim().split(/\r?\n/u);
  const data = lines.filter(line => !line.startsWith('=')).join('');
  if (!data || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) throw new Error('Invalid OpenPGP armor data.');
  return Buffer.from(data, 'base64');
}

function packet(bytes) {
  if (bytes.length < 2 || !(bytes[0] & 128)) throw new Error('Invalid OpenPGP packet.');
  let offset = 1, length, tag;
  if (bytes[0] & 64) {
    tag = bytes[0] & 63;
    const n = bytes[offset++];
    if (n < 192) length = n;
    else if (n < 224) { if (offset >= bytes.length) throw new Error('Truncated packet.'); length = ((n - 192) << 8) + bytes[offset++] + 192; }
    else if (n === 255 && bytes.length >= offset + 4) { length = bytes.readUInt32BE(offset); offset += 4; }
    else throw new Error('Partial OpenPGP packets are unsupported.');
  } else {
    tag = (bytes[0] >> 2) & 15;
    const kind = bytes[0] & 3;
    if (kind === 3) throw new Error('Indeterminate OpenPGP packets are unsupported.');
    const width = 1 << kind;
    if (bytes.length < offset + width) throw new Error('Truncated packet.');
    length = bytes.readUIntBE(offset, width); offset += width;
  }
  if (length < 1 || offset + length > bytes.length) throw new Error('Truncated OpenPGP body.');
  return { tag, body: bytes.subarray(offset, offset + length), end: offset + length };
}

function mpi(bytes, offset) {
  if (offset + 2 > bytes.length) throw new Error('Truncated MPI.');
  const length = Math.ceil(bytes.readUInt16BE(offset) / 8);
  if (!length || offset + 2 + length > bytes.length) throw new Error('Invalid MPI.');
  return { value: bytes.subarray(offset + 2, offset + 2 + length), end: offset + 2 + length };
}

export function verifyRsaBinaryDocument({ archive, signature, publicKey, fingerprint }) {
  const keyPacket = packet(armor(publicKey, 'PUBLIC KEY BLOCK'));
  const signatureBytes = armor(signature, 'SIGNATURE'), signaturePacket = packet(signatureBytes);
  const keyBody = keyPacket.body, sig = signaturePacket.body;
  if (keyPacket.tag !== 6 || keyBody.length < 8 || keyBody[0] !== 4 || keyBody[5] !== 1
    || signaturePacket.tag !== 2 || signaturePacket.end !== signatureBytes.length || sig.length < 10
    || sig[0] !== 4 || sig[1] !== 0 || sig[2] !== 1 || sig[3] !== 10) throw new Error('Only OpenPGP v4 RSA/SHA512 binary-document signatures are supported.');
  const keyPrefix = Buffer.alloc(3); keyPrefix[0] = 0x99; keyPrefix.writeUInt16BE(keyBody.length, 1);
  const actualFingerprint = createHash('sha1').update(keyPrefix).update(keyBody).digest('hex').toUpperCase();
  if (actualFingerprint !== fingerprint) throw new Error('Unexpected source signing key fingerprint.');
  const modulus = mpi(keyBody, 6), exponent = mpi(keyBody, modulus.end);
  if (exponent.end !== keyBody.length || modulus.value.length !== 256) throw new Error('Unexpected RSA key shape.');
  const key = createPublicKey({ format: 'jwk', key: { kty: 'RSA', n: modulus.value.toString('base64url'), e: exponent.value.toString('base64url') } });
  const headerLength = 6 + sig.readUInt16BE(4);
  if (headerLength + 2 > sig.length) throw new Error('Truncated signature header.');
  const hashOffset = headerLength + 2 + sig.readUInt16BE(headerLength);
  if (hashOffset + 4 > sig.length) throw new Error('Truncated signature payload.');
  const header = sig.subarray(0, headerLength), trailer = Buffer.alloc(6);
  trailer[0] = 4; trailer[1] = 255; trailer.writeUInt32BE(headerLength, 2);
  const digest = createHash('sha512').update(archive).update(header).update(trailer).digest();
  if (!digest.subarray(0, 2).equals(sig.subarray(hashOffset, hashOffset + 2))) throw new Error('Detached signature digest does not match.');
  const value = mpi(sig, hashOffset + 2);
  if (value.end !== sig.length || value.value.length > modulus.value.length) throw new Error('Invalid RSA signature payload.');
  const padded = Buffer.concat([Buffer.alloc(modulus.value.length - value.value.length), value.value]);
  if (!createVerify('RSA-SHA512').update(archive).update(header).update(trailer).verify(key, padded)) throw new Error('Invalid FFmpeg detached RSA signature.');
  return true;
}
