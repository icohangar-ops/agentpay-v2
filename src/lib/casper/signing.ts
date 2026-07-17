// Casper deploy signature support for both Ed25519 and Secp256k1 keys.
//
// Casper deploy signatures:
//   - Ed25519:    64-byte raw signature (r||s)
//   - Secp256k1:  64-byte compact signature (r||s, low-s normalized, NO recovery byte)
//
// The signature is computed over the deploy hash (32 bytes), which is the
// Blake2b-256 of the bincode-serialized deploy body. The hash itself is
// produced externally — this module only handles signing.

import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { decodePublicKey, type KeyAlgorithm } from './account-hash';

export interface KeyPair {
  algorithm: KeyAlgorithm;
  /** 32-byte private key (raw, no parity) */
  privateKey: Uint8Array;
  /** Casper-format public key (with algorithm tag, hex string) */
  publicKeyHex: string;
}

export interface DeploySignature {
  algorithm: KeyAlgorithm;
  /** 64-byte signature (compact r||s for secp256k1, raw for ed25519) */
  signature: Uint8Array;
}

/**
 * Sign a 32-byte deploy hash with the given private key.
 *
 * @param deployHash 32-byte hash of the deploy body
 * @param privateKey 32-byte raw private key (no prefix)
 * @param algorithm 'ed25519' or 'secp256k1'
 */
export function signDeployHash(
  deployHash: Uint8Array,
  privateKey: Uint8Array,
  algorithm: KeyAlgorithm,
): DeploySignature {
  if (deployHash.length !== 32) throw new Error(`deployHash must be 32 bytes (got ${deployHash.length})`);
  if (privateKey.length !== 32) throw new Error(`privateKey must be 32 bytes (got ${privateKey.length})`);

  if (algorithm === 'ed25519') {
    const signature = ed25519.sign(deployHash, privateKey);
    return { algorithm, signature };
  }
  if (algorithm === 'secp256k1') {
    // Casper expects 64-byte compact r||s, low-s normalized, no recovery byte.
    const sig = secp256k1.sign(deployHash, privateKey);
    return { algorithm, signature: sig.toCompactRawBytes() };
  }
  throw new Error('Unknown algorithm: ' + algorithm);
}

/**
 * Verify a deploy signature against a public key.
 */
export function verifyDeploySignature(
  deployHash: Uint8Array,
  signature: Uint8Array,
  publicKeyHex: string,
): boolean {
  if (deployHash.length !== 32) throw new Error(`deployHash must be 32 bytes (got ${deployHash.length})`);
  if (signature.length !== 64) throw new Error(`signature must be 64 bytes (got ${signature.length})`);

  const { algorithm, bytes: pubKeyBytes } = decodePublicKey(publicKeyHex);

  if (algorithm === 'ed25519') {
    return ed25519.verify(signature, deployHash, pubKeyBytes);
  }
  if (algorithm === 'secp256k1') {
    // pubKeyBytes is 33-byte compressed. secp256k1.verify accepts compressed keys.
    return secp256k1.verify(signature, deployHash, pubKeyBytes);
  }
  return false;
}

/**
 * Format a signature for inclusion in a Casper deploy's `approvals` array.
 *
 * Casper deploy approval format:
 *   { "signer": "<pubkey-hex-with-algo-tag>", "signature": "<algo-tag><sig-hex>" }
 *
 * The signature is prefixed with the algorithm tag byte:
 *   - Ed25519:    `01` + 64-byte sig  (130 hex chars)
 *   - Secp256k1:  `02` + 64-byte sig  (130 hex chars)
 */
export function formatApproval(publicKeyHex: string, sig: DeploySignature): {
  signer: string;
  signature: string;
} {
  const algoTag = sig.algorithm === 'ed25519' ? '01' : '02';
  return {
    signer: publicKeyHex,
    signature: algoTag + Buffer.from(sig.signature).toString('hex'),
  };
}
