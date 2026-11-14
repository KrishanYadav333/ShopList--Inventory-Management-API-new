// WebAuthn (passkeys), verified here with WebCrypto only. ES256 (P-256) credentials, no attestation.
// One signature check per sign-in keeps this inside the free plan's CPU budget.
import { base64url, safeEqual } from './util';
import { AppError } from './errors';

const enc = new TextEncoder();
const bad = (why: string) => new AppError(400, 'passkey_invalid', `The passkey response was rejected (${why}).`);

export const fromB64url = (s: string): Uint8Array => {
  const p = s.replaceAll('-', '+').replaceAll('_', '/');
  const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

// ------------------------------------------------------------------- minimal CBOR (just what WebAuthn uses)
type Cbor = number | Uint8Array | string | Cbor[] | Map<Cbor, Cbor>;

function readCbor(b: Uint8Array, at: { i: number }, depth = 0): Cbor {
  if (depth > 8 || at.i >= b.length) throw bad('malformed CBOR');
  const head = b[at.i++];
  const major = head >> 5;
  const info = head & 31;
  let len = info;
  if (info === 24) len = b[at.i++];
  else if (info === 25) { len = (b[at.i] << 8) | b[at.i + 1]; at.i += 2; }
  else if (info === 26) { len = ((b[at.i] << 24) | (b[at.i + 1] << 16) | (b[at.i + 2] << 8) | b[at.i + 3]) >>> 0; at.i += 4; }
  else if (info > 26) throw bad('unsupported CBOR');
  if (major === 0) return len;
  if (major === 1) return -1 - len;
  if (major === 2 || major === 3) {
    if (at.i + len > b.length) throw bad('malformed CBOR');
    const bytes = b.slice(at.i, at.i + len);
    at.i += len;
    return major === 2 ? bytes : new TextDecoder().decode(bytes);
  }
  if (major === 4) return Array.from({ length: len }, () => readCbor(b, at, depth + 1));
  if (major === 5) {
    const m = new Map<Cbor, Cbor>();
    for (let n = 0; n < len; n++) m.set(readCbor(b, at, depth + 1), readCbor(b, at, depth + 1));
    return m;
  }
  throw bad('unsupported CBOR');
}

const readCborValue = (b: Uint8Array): { value: Cbor; end: number } => {
  const at = { i: 0 };
  return { value: readCbor(b, at), end: at.i };
};

// ------------------------------------------------------------------- shared checks
export interface ClientData { type: string; challenge: string; origin: string; crossOrigin?: boolean }

function checkClientData(raw: Uint8Array, type: 'webauthn.create' | 'webauthn.get', challenge: string, origin: string): void {
  let cd: ClientData;
  try { cd = JSON.parse(new TextDecoder().decode(raw)) as ClientData; } catch { throw bad('client data'); }
  if (cd.type !== type) throw bad('wrong ceremony');
  if (typeof cd.challenge !== 'string' || !safeEqual(cd.challenge, challenge)) throw bad('challenge');
  if (cd.origin !== origin) throw bad('origin');
  if (cd.crossOrigin === true) throw bad('cross-origin');
}

async function checkAuthData(authData: Uint8Array, rpId: string): Promise<{ flags: number; counter: number }> {
  if (authData.length < 37) throw bad('authenticator data');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(rpId)));
  if (!safeEqual(base64url(hash), base64url(authData.slice(0, 32)))) throw bad('relying party');
  const flags = authData[32];
  if (!(flags & 0x01)) throw bad('user not present');
  if (!(flags & 0x04)) throw bad('user not verified'); // passkeys must verify the user (biometric or PIN)
  const counter = ((authData[33] << 24) | (authData[34] << 16) | (authData[35] << 8) | authData[36]) >>> 0;
  return { flags, counter };
}

// ------------------------------------------------------------------- registration
/** Returns the credential id and the public key as an uncompressed P-256 point (65 bytes). */
export async function verifyRegistration(input: { clientDataJSON: string; attestationObject: string }, expect: { challenge: string; origin: string; rpId: string }): Promise<{ credentialId: string; publicKey: Uint8Array; counter: number }> {
  checkClientData(fromB64url(input.clientDataJSON), 'webauthn.create', expect.challenge, expect.origin);
  const att = readCborValue(fromB64url(input.attestationObject)).value;
  if (!(att instanceof Map)) throw bad('attestation');
  const authData = att.get('authData');
  if (!(authData instanceof Uint8Array)) throw bad('attestation');
  const { flags, counter } = await checkAuthData(authData, expect.rpId);
  if (!(flags & 0x40)) throw bad('no credential data');
  const idLen = (authData[53] << 8) | authData[54];
  const credentialId = authData.slice(55, 55 + idLen);
  if (!idLen || credentialId.length !== idLen) throw bad('credential id');
  const cose = readCborValue(authData.slice(55 + idLen)).value;
  if (!(cose instanceof Map)) throw bad('public key');
  // COSE EC2 key: kty 2, alg -7 (ES256), crv 1 (P-256).
  const x = cose.get(-2), y = cose.get(-3);
  if (cose.get(1) !== 2 || cose.get(3) !== -7 || cose.get(-1) !== 1 || !(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) throw bad('unsupported key type');
  const publicKey = new Uint8Array(65);
  publicKey[0] = 4;
  publicKey.set(x, 1);
  publicKey.set(y, 33);
  await crypto.subtle.importKey('raw', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']).catch(() => { throw bad('invalid public key'); });
  return { credentialId: base64url(credentialId), publicKey, counter };
}

// ------------------------------------------------------------------- sign-in
/** ASN.1 DER ECDSA signature → the r||s form WebCrypto expects. */
function derToRaw(der: Uint8Array): Uint8Array {
  let i = 2;
  if (der[0] !== 0x30) throw bad('signature');
  if (der[1] & 0x80) i += der[1] & 0x7f;
  const out = new Uint8Array(64);
  for (let part = 0; part < 2; part++) {
    if (der[i++] !== 0x02) throw bad('signature');
    let len = der[i++];
    let start = i;
    i += len;
    while (len > 32 && der[start] === 0) { start++; len--; }
    if (len > 32) throw bad('signature');
    out.set(der.slice(start, start + len), part * 32 + 32 - len);
  }
  return out;
}

/** Throws unless the assertion is a valid signature by `publicKey` for this challenge. Returns the new counter. */
export async function verifyAssertion(
  input: { clientDataJSON: string; authenticatorData: string; signature: string },
  stored: { publicKey: Uint8Array; counter: number },
  expect: { challenge: string; origin: string; rpId: string },
): Promise<number> {
  const clientData = fromB64url(input.clientDataJSON);
  checkClientData(clientData, 'webauthn.get', expect.challenge, expect.origin);
  const authData = fromB64url(input.authenticatorData);
  const { counter } = await checkAuthData(authData, expect.rpId);
  // A counter that goes backwards means a cloned authenticator. Many authenticators keep it at 0, which is allowed.
  if ((counter !== 0 || stored.counter !== 0) && counter <= stored.counter) throw new AppError(400, 'passkey_invalid', 'The passkey response was rejected (counter).');
  const key = await crypto.subtle.importKey('raw', stored.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientData));
  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData);
  signed.set(clientHash, authData.length);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(fromB64url(input.signature)), signed);
  if (!ok) throw new AppError(400, 'passkey_invalid', 'The passkey response was rejected (signature).');
  return counter;
}
