import { api } from './api';

const toBytes = (s: string) => {
  const p = s.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(p + '='.repeat((4 - (p.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const toB64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

export const passkeysSupported = () => typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;

interface Options { token: string; publicKey: Record<string, any> }

/** True when the person closed or refused the browser's passkey prompt, which is not an error worth shouting about. */
export const wasCancelled = (e: unknown) => e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError');

export async function addPasskey(name: string): Promise<void> {
  const o = await api<Options>('POST', '/auth/passkeys/register/options', { body: {} });
  const pk = o.publicKey;
  const cred = (await navigator.credentials.create({
    publicKey: {
      ...pk,
      challenge: toBytes(pk.challenge),
      user: { ...pk.user, id: toBytes(pk.user.id) },
      excludeCredentials: pk.excludeCredentials.map((c: { id: string }) => ({ ...c, id: toBytes(c.id) })),
    } as unknown as PublicKeyCredentialCreationOptions,
  })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException('cancelled', 'NotAllowedError');
  const r = cred.response as AuthenticatorAttestationResponse;
  await api('POST', '/auth/passkeys/register', {
    body: { token: o.token, clientDataJSON: toB64(r.clientDataJSON), attestationObject: toB64(r.attestationObject), transports: r.getTransports?.() ?? [], name },
  });
}

export async function signInWithPasskey(): Promise<void> {
  const o = await api<Options>('POST', '/auth/passkeys/login/options', { body: {} });
  const cred = (await navigator.credentials.get({ publicKey: { ...o.publicKey, challenge: toBytes(o.publicKey.challenge) } as unknown as PublicKeyCredentialRequestOptions })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException('cancelled', 'NotAllowedError');
  const r = cred.response as AuthenticatorAssertionResponse;
  await api('POST', '/auth/passkeys/login', {
    body: { token: o.token, id: cred.id, clientDataJSON: toB64(r.clientDataJSON), authenticatorData: toB64(r.authenticatorData), signature: toB64(r.signature) },
  });
}
