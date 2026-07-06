// Account-security helpers: TOTP two-factor codes, WebAuthn (passkey)
// verification, short-lived challenge storage, and the dev mailer used for
// password-recovery links. No external dependencies — WebAuthn needs only a
// small CBOR/COSE subset, verified with node:crypto.

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { DATA_DIR } = require('./db');

// ---------- dev mailer ----------
// There is no SMTP server in development, so "sent" mail is written to
// data/outbox and logged. Swap this function for a real mailer in production.

const OUTBOX_DIR = path.join(DATA_DIR, 'outbox');

function sendMail(to, subject, body) {
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  const file = path.join(OUTBOX_DIR, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.txt`);
  fs.writeFileSync(file, `To: ${to}\nSubject: ${subject}\n\n${body}\n`);
  console.log(`[mail] "${subject}" for ${to} -> ${file}`);
}

// ---------- short-lived one-time challenges ----------
// Used for WebAuthn ceremonies and pending 2FA logins. In-memory is fine for
// the single-process server (matches the in-process transcode queue).

const challenges = new Map();

function putChallenge(kind, data, ttlMs = 5 * 60 * 1000) {
  const token = crypto.randomBytes(16).toString('hex');
  challenges.set(token, { kind, data, expires: Date.now() + ttlMs });
  return token;
}

function takeChallenge(kind, token) {
  const entry = challenges.get(String(token || ''));
  challenges.delete(String(token || ''));
  if (!entry || entry.kind !== kind || entry.expires < Date.now()) return null;
  return entry.data;
}

// Non-consuming lookup for challenges that allow a few attempts (2FA login);
// callers drop the challenge on success or when attempts run out.
function peekChallenge(kind, token) {
  const entry = challenges.get(String(token || ''));
  if (!entry || entry.kind !== kind || entry.expires < Date.now()) return null;
  return entry.data;
}
function dropChallenge(token) {
  challenges.delete(String(token || ''));
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
}, 60 * 1000).unref();

// ---------- TOTP (RFC 6238, SHA-1, 6 digits, 30s steps) ----------

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(str).toUpperCase().replace(/=+$/, '')) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function newTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBuf, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = (((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]) % 1e6;
  return String(code).padStart(6, '0');
}

// Accept the current 30s step plus one either side for clock drift.
function verifyTotp(secret, code, window = 1) {
  const cleaned = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  const key = base32Decode(secret);
  const step = Math.floor(Date.now() / 30000);
  for (let i = -window; i <= window; i++) {
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, step + i)), Buffer.from(cleaned))) return true;
  }
  return false;
}

function otpauthUrl(secret, username) {
  return `otpauth://totp/Anchor:${encodeURIComponent(username)}?secret=${secret}&issuer=Anchor&digits=6&period=30`;
}

// ---------- WebAuthn ----------

// Minimal CBOR decoder covering what attestation objects and COSE keys use:
// uints, negative ints, byte/text strings, arrays and maps.
function cborDecodeFirst(buf, off = 0) {
  const first = buf[off];
  const major = first >> 5;
  const info = first & 31;
  let len = info, next = off + 1;
  if (info === 24) { len = buf[next]; next += 1; }
  else if (info === 25) { len = buf.readUInt16BE(next); next += 2; }
  else if (info === 26) { len = buf.readUInt32BE(next); next += 4; }
  else if (info === 27) { len = Number(buf.readBigUInt64BE(next)); next += 8; }
  else if (info > 27) throw new Error('Unsupported CBOR item');
  switch (major) {
    case 0: return [len, next];
    case 1: return [-1 - len, next];
    case 2: return [buf.subarray(next, next + len), next + len];
    case 3: return [buf.subarray(next, next + len).toString('utf8'), next + len];
    case 4: {
      const arr = [];
      for (let i = 0; i < len; i++) { const [v, n] = cborDecodeFirst(buf, next); arr.push(v); next = n; }
      return [arr, next];
    }
    case 5: {
      const map = new Map();
      for (let i = 0; i < len; i++) {
        const [k, n1] = cborDecodeFirst(buf, next);
        const [v, n2] = cborDecodeFirst(buf, n1);
        map.set(k, v); next = n2;
      }
      return [map, next];
    }
    default: throw new Error('Unsupported CBOR type');
  }
}

// COSE_Key -> JWK usable with node's crypto.createPublicKey.
function coseToJwk(cose) {
  const kty = cose.get(1);
  const alg = cose.get(3);
  const b64 = b => Buffer.from(b).toString('base64url');
  if (kty === 2 && alg === -7 && cose.get(-1) === 1) { // EC2 / ES256 / P-256
    return { jwk: { kty: 'EC', crv: 'P-256', x: b64(cose.get(-2)), y: b64(cose.get(-3)) }, alg: 'ES256' };
  }
  if (kty === 3 && alg === -257) { // RSA / RS256
    return { jwk: { kty: 'RSA', n: b64(cose.get(-1)), e: b64(cose.get(-2)) }, alg: 'RS256' };
  }
  throw new Error('Unsupported passkey algorithm');
}

function parseAuthData(authData) {
  const rpIdHash = authData.subarray(0, 32);
  const flags = authData[32];
  const signCount = authData.readUInt32BE(33);
  const parsed = { rpIdHash, flags, signCount, userPresent: !!(flags & 1) };
  if (flags & 0x40) { // attested credential data present
    const credIdLen = authData.readUInt16BE(53);
    parsed.credentialId = authData.subarray(55, 55 + credIdLen);
    const [cose] = cborDecodeFirst(authData, 55 + credIdLen);
    parsed.cose = cose;
  }
  return parsed;
}

function checkClientData(clientDataJSON, expectedType, expectedChallenge, expectedOrigin) {
  const clientData = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8'));
  if (clientData.type !== expectedType) throw new Error('Wrong ceremony type.');
  if (clientData.challenge !== expectedChallenge) throw new Error('Challenge mismatch.');
  if (clientData.origin !== expectedOrigin) throw new Error(`Origin mismatch (${clientData.origin}).`);
  return clientData;
}

// Registration: validate the ceremony and extract the credential to store.
function verifyRegistration({ response, challenge, origin, rpId }) {
  checkClientData(response.clientDataJSON, 'webauthn.create', challenge, origin);
  const [attestation] = cborDecodeFirst(Buffer.from(response.attestationObject, 'base64url'));
  const auth = parseAuthData(Buffer.from(attestation.get('authData')));
  if (!auth.userPresent) throw new Error('User presence required.');
  const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
  if (!auth.rpIdHash.equals(rpIdHash)) throw new Error('rpId mismatch.');
  if (!auth.credentialId) throw new Error('No credential in attestation.');
  const { jwk, alg } = coseToJwk(auth.cose);
  return {
    credentialId: Buffer.from(auth.credentialId).toString('base64url'),
    publicKey: JSON.stringify({ jwk, alg }),
    counter: auth.signCount,
  };
}

// Authentication: verify the assertion signature against the stored key.
function verifyAssertion({ response, challenge, origin, rpId, storedKey, storedCounter }) {
  checkClientData(response.clientDataJSON, 'webauthn.get', challenge, origin);
  const authData = Buffer.from(response.authenticatorData, 'base64url');
  const auth = parseAuthData(authData);
  if (!auth.userPresent) throw new Error('User presence required.');
  const rpIdHash = crypto.createHash('sha256').update(rpId).digest();
  if (!auth.rpIdHash.equals(rpIdHash)) throw new Error('rpId mismatch.');

  const { jwk } = JSON.parse(storedKey);
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const clientDataHash = crypto.createHash('sha256')
    .update(Buffer.from(response.clientDataJSON, 'base64url')).digest();
  const signed = Buffer.concat([authData, clientDataHash]);
  const ok = crypto.verify('sha256', signed, key, Buffer.from(response.signature, 'base64url'));
  if (!ok) throw new Error('Signature verification failed.');
  // A counter that goes backwards suggests a cloned authenticator.
  if (auth.signCount !== 0 && auth.signCount <= storedCounter && storedCounter !== 0) {
    throw new Error('Suspicious authenticator counter.');
  }
  return { counter: auth.signCount };
}

module.exports = {
  sendMail, OUTBOX_DIR,
  putChallenge, takeChallenge, peekChallenge, dropChallenge,
  newTotpSecret, verifyTotp, otpauthUrl,
  verifyRegistration, verifyAssertion,
};
