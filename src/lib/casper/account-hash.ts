// Casper account hash algorithm — verified against the testnet for both
// Ed25519 and Secp256k1 keys.
//
// Preimage layout (per casper-node v2.0.0 types/src/account/account_hash.rs):
//   blake2b256(algo_name_lowercase (ASCII) || 0x00 || Vec<u8>::from(&PublicKey))
//
// Where Vec<u8>::from(&PublicKey) is:
//   - Ed25519: 32 raw key bytes (no tag)
//   - Secp256k1: 33-byte compressed key (with 02/03 parity byte), no algo tag
//
// IMPORTANT: Node's built-in `crypto.createHash('blake2b256')` produces a
// different hash. Use @noble/hashes/blake2b instead.

import { blake2b } from '@noble/hashes/blake2b';

export type KeyAlgorithm = 'ed25519' | 'secp256k1';

export interface DecodedPublicKey {
  algorithm: KeyAlgorithm;
  /** Raw key bytes — 32 for ed25519, 33 for secp256k1 (compressed, with parity) */
  bytes: Uint8Array;
}

export function decodePublicKey(publicKeyHex: string): DecodedPublicKey {
  // Casper public key format (with algorithm tag):
  //   - Ed25519:    `01` + 32-byte raw key          (66 hex chars total)
  //   - Secp256k1:  `02` + 33-byte compressed key   (68 hex chars total)
  //
  // Note: for secp256k1, the 33-byte body itself starts with a `02`/`03` parity byte
  // (compressed key format). The leading `02` of the Casper key is the ALGORITHM TAG,
  // not the parity byte.
  const clean = publicKeyHex.replace(/^0x/, '').toLowerCase();
  if (clean.length < 2) throw new Error('Public key too short: ' + publicKeyHex);
  const prefix = clean.slice(0, 2);
  const rest = clean.slice(2);

  if (prefix === '01') {
    if (rest.length !== 64) throw new Error(`Ed25519 key body must be 32 bytes (got ${rest.length / 2})`);
    return { algorithm: 'ed25519', bytes: Buffer.from(rest, 'hex') };
  }
  if (prefix === '02') {
    if (rest.length !== 66) throw new Error(`secp256k1 key body must be 33 bytes (got ${rest.length / 2})`);
    return { algorithm: 'secp256k1', bytes: Buffer.from(rest, 'hex') };
  }
  throw new Error(`Unknown algorithm prefix: ${prefix} (expected 01=ed25519 or 02=secp256k1)`);
}

export function computeAccountHash(publicKeyHex: string): string {
  const { algorithm, bytes } = decodePublicKey(publicKeyHex);
  const preimage = Buffer.concat([
    Buffer.from(algorithm, 'ascii'),
    Buffer.from([0x00]),
    Buffer.from(bytes),
  ]);
  const out = blake2b(preimage, { dkLen: 32 });
  return `account-hash-${Buffer.from(out).toString('hex')}`;
}
