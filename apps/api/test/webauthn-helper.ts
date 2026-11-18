import { ORIGIN } from './helpers';

// A software authenticator: makes the same bytes a browser would hand over.
export const enc = new TextEncoder();
export const b64 = (b: ArrayBuffer | Uint8Array) => {
  let s = '';
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};
export const cat = (...parts: Uint8Array[]) => { const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
export const sha = async (s: string | Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', typeof s === 'string' ? enc.encode(s) : s));

// Tiny CBOR writer for exactly the shapes WebAuthn needs.
const head = (major: number, n: number) => (n < 24 ? Uint8Array.of((major << 5) | n) : n < 256 ? Uint8Array.of((major << 5) | 24, n) : Uint8Array.of((major << 5) | 25, n >> 8, n & 255));
const cInt = (n: number) => (n >= 0 ? head(0, n) : head(1, -1 - n));
const cBytes = (b: Uint8Array) => cat(head(2, b.length), b);
const cText = (s: string) => cat(head(3, s.length), enc.encode(s));
const cMap = (...pairs: Uint8Array[]) => cat(head(5, pairs.length / 2), ...pairs);

function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => { let i = 0; while (i < 31 && b[i] === 0) i++; let v = b.slice(i); if (v[0] & 0x80) v = cat(Uint8Array.of(0), v); return cat(Uint8Array.of(2, v.length), v); };
  const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return cat(Uint8Array.of(0x30, body.length), body);
}

export const RP = 'localhost';
export async function authenticator() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer);
  const credId = crypto.getRandomValues(new Uint8Array(32));
  let counter = 0;
  const flags = { up: 1, uv: 4, at: 0x40 };
  return {
    id: b64(credId),
    async register(challenge: string, o: { origin?: string; rp?: string; uv?: boolean } = {}) {
      const cose = cMap(cInt(1), cInt(2), cInt(3), cInt(-7), cInt(-1), cInt(1), cInt(-2), cBytes(pub.slice(1, 33)), cInt(-3), cBytes(pub.slice(33)));
      const authData = cat(await sha(o.rp ?? RP), Uint8Array.of(flags.up | (o.uv === false ? 0 : flags.uv) | flags.at), new Uint8Array(4), new Uint8Array(16), Uint8Array.of(0, credId.length), credId, cose);
      const clientData = JSON.stringify({ type: 'webauthn.create', challenge, origin: o.origin ?? ORIGIN });
      return { clientDataJSON: b64(enc.encode(clientData)), attestationObject: b64(cMap(cText('fmt'), cText('none'), cText('attStmt'), cMap(), cText('authData'), cBytes(authData))) };
    },
    async assert(challenge: string, o: { origin?: string; counter?: number; type?: string; tamper?: boolean } = {}) {
      counter = o.counter ?? counter + 1;
      const authData = cat(await sha(RP), Uint8Array.of(flags.up | flags.uv), Uint8Array.of(counter >>> 24, (counter >>> 16) & 255, (counter >>> 8) & 255, counter & 255));
      const clientData = enc.encode(JSON.stringify({ type: o.type ?? 'webauthn.get', challenge, origin: o.origin ?? ORIGIN }));
      const signed = cat(authData, await sha(clientData));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, signed));
      if (o.tamper) raw[10] ^= 1;
      return { id: b64(credId), clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(rawToDer(raw)) };
    },
  };
}

