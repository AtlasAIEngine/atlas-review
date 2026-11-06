/**
 * DPoP (Demonstrating Proof-of-Possession) proof creation.
 *
 * Creates signed JWT proofs that bind HTTP requests to the device's Ed25519 keypair.
 * The cloud backend verifies these to authenticate requests without passwords.
 *
 * DPoP spec: https://datatracker.ietf.org/doc/html/rfc9449
 */

import { SignJWT, exportJWK } from 'jose';
import { getPrivateKey, getPublicKey } from './keyManager';

/**
 * Create a DPoP proof JWT for an HTTP request.
 *
 * Header: { typ: "dpop+jwt", alg: "EdDSA", jwk: <public key JWK> }
 * Claims: { jti, htm, htu, iat }
 *
 * @param method HTTP method (GET, POST, etc.)
 * @param url Full request URL (scheme + host + path, no query)
 */
export async function createDPoPProof(method: string, url: string): Promise<string> {
  const privateKey = getPrivateKey();
  const publicKey = getPublicKey();
  const publicJwk = await exportJWK(publicKey);

  // Strip query string and fragment for htu
  const htu = url.split('?')[0].split('#')[0];

  const proof = await new SignJWT({
    jti: crypto.randomUUID(),
    htm: method.toUpperCase(),
    htu,
    iat: Math.floor(Date.now() / 1000),
  })
    .setProtectedHeader({
      typ: 'dpop+jwt',
      alg: 'EdDSA',
      jwk: publicJwk,
    })
    .sign(privateKey);

  return proof;
}
