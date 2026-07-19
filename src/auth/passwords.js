// Password hashing — scrypt with a per-user random salt, constant-time compare.
// Zero dependencies (node:crypto). The stored string is self-describing so the
// parameters travel with the hash and can be tuned later without a migration:
//
//   scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>
//
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// Interactive-login cost. N=16384 (2^14) keeps a hash well under ~100ms on a
// small VPS while staying expensive to brute-force. maxmem is raised so Node
// does not reject the 16384*r*p*128 memory request.
const PARAMS = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

/**
 * @param {string} password
 * @returns {Promise<string>} the self-describing hash string
 */
export async function hashPassword(password) {
  if (!password || String(password).length < 1) {
    throw new Error('hashPassword: password required');
  }
  const salt = randomBytes(16);
  const dk = await scryptAsync(String(password), salt, KEYLEN, { ...PARAMS, maxmem: MAXMEM });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    dk.toString('base64'),
  ].join('$');
}

/**
 * Constant-time verify. Never throws — returns false on any malformed input.
 * @param {string} password
 * @param {string} stored  a string produced by hashPassword()
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  try {
    if (!password || !stored) return false;
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const dk = await scryptAsync(String(password), salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: MAXMEM,
    });
    return dk.length === expected.length && timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}
