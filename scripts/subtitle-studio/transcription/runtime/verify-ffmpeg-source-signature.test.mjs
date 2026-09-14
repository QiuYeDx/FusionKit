import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { verifyRsaBinaryDocument } from './verify-ffmpeg-source-signature.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
const integer = value => { const prefix = Buffer.alloc(2); prefix.writeUInt16BE(value.length * 8 - Math.clz32(value[0]) + 24); return Buffer.concat([prefix, value]); };
const pack = (tag, bytes) => { const header = Buffer.alloc(3); header[0] = 0x80 | (tag << 2) | 1; header.writeUInt16BE(bytes.length, 1); return Buffer.concat([header, bytes]); };
const armor = (kind, bytes) => Buffer.from(`-----BEGIN PGP ${kind}-----\n\n${bytes.toString('base64')}\n-----END PGP ${kind}-----\n`);
const keyBody = Buffer.concat([Buffer.from([4, 0, 0, 0, 0, 1]), integer(Buffer.from(jwk.n, 'base64url')), integer(Buffer.from(jwk.e, 'base64url'))]);
const publicKeyArmor = armor('PUBLIC KEY BLOCK', pack(6, keyBody));
const keyPrefix = Buffer.alloc(3); keyPrefix[0] = 0x99; keyPrefix.writeUInt16BE(keyBody.length, 1);
const fingerprint = createHash('sha1').update(keyPrefix).update(keyBody).digest('hex').toUpperCase();
const archive = Buffer.from('a real RSA signature over an isolated test document');
const header = Buffer.from([4, 0, 1, 10, 0, 0]), trailer = Buffer.from([4, 255, 0, 0, 0, 6]);
const data = Buffer.concat([archive, header, trailer]);
const signatureBody = Buffer.concat([header, Buffer.from([0, 0]), createHash('sha512').update(data).digest().subarray(0, 2), integer(sign('RSA-SHA512', data, privateKey))]);
const input = { archive, publicKey: publicKeyArmor, signature: armor('SIGNATURE', pack(2, signatureBody)), fingerprint };

test('verifies an actual OpenSSL RSA signature using the exact trusted key fingerprint', () => {
  assert.equal(verifyRsaBinaryDocument(input), true);
});
test('rejects changed content and an untrusted signing key', () => {
  assert.throws(() => verifyRsaBinaryDocument({ ...input, archive: Buffer.from('changed') }), /digest/u);
  assert.throws(() => verifyRsaBinaryDocument({ ...input, fingerprint: '0'.repeat(40) }), /fingerprint/u);
});
test('rejects an altered RSA signature despite a matching two-byte digest prefix', () => {
  const broken = Buffer.from(signatureBody); broken[broken.length - 1] ^= 1;
  assert.throws(() => verifyRsaBinaryDocument({ ...input, signature: armor('SIGNATURE', pack(2, broken)) }), /RSA signature/u);
});
test('rejects unsupported algorithms, truncation and extra signature packets', () => {
  const wrongAlgorithm = Buffer.from(signatureBody); wrongAlgorithm[3] = 8;
  assert.throws(() => verifyRsaBinaryDocument({ ...input, signature: armor('SIGNATURE', pack(2, wrongAlgorithm)) }), /Only OpenPGP/u);
  assert.throws(() => verifyRsaBinaryDocument({ ...input, signature: armor('SIGNATURE', pack(2, signatureBody).subarray(0, 20)) }), /Truncated/u);
  assert.throws(() => verifyRsaBinaryDocument({ ...input, signature: armor('SIGNATURE', Buffer.concat([pack(2, signatureBody), pack(2, signatureBody)])) }), /Only OpenPGP/u);
});
