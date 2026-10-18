/**
 * KDF tests. Run with: node web/test/kdf.test.mjs
 *
 * The vector is the one internal/auth/auth_test.go pins, computed with
 * Python's hashlib on 2026-10-18. If this and the Go test disagree, the app
 * and the server have drifted and nobody can sign in.
 */

import assert from 'node:assert/strict';
import { deriveKey, normaliseEmail, KDF, ITERATIONS } from '../js/kdf.js';

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (err) { console.error('FAIL  ' + name + '\n      ' + (err.stack || err.message)); process.exitCode = 1; }
}

console.log('kdf');

await test('matches the pinned protocol vector', async () => {
  assert.equal(KDF, 'pbkdf2-sha256-v1');
  assert.equal(ITERATIONS, 600000);
  const out = await deriveKey('alice@example.com', 'correct horse battery');
  assert.equal(out.kdf, 'pbkdf2-sha256-v1');
  assert.equal(out.key, 'FbRV4S3euJ0g7iQp-_cgZ_u4tLgodJLnRVrcS7TsbLA');
});

await test('email case and whitespace do not change the key', async () => {
  assert.equal(normaliseEmail('  Alice@Example.COM '), 'alice@example.com');
  const a = await deriveKey('  Alice@Example.COM ', 'correct horse battery');
  assert.equal(a.key, 'FbRV4S3euJ0g7iQp-_cgZ_u4tLgodJLnRVrcS7TsbLA');
});

await test('a different password or email gives a different key', async () => {
  const a = await deriveKey('alice@example.com', 'correct horse batterx');
  const b = await deriveKey('alica@example.com', 'correct horse battery');
  assert.notEqual(a.key, 'FbRV4S3euJ0g7iQp-_cgZ_u4tLgodJLnRVrcS7TsbLA');
  assert.notEqual(b.key, 'FbRV4S3euJ0g7iQp-_cgZ_u4tLgodJLnRVrcS7TsbLA');
  assert.notEqual(a.key, b.key);
});

await test('short passwords are refused before any work is done', async () => {
  await assert.rejects(deriveKey('alice@example.com', 'short'), /at least 10/);
});

console.log(`${passed} passed`);
