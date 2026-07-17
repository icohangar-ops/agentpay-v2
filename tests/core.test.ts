// Unit tests for the AgentPay core primitives.
//
// Run with: bun test
//
// These tests verify the deterministic pieces — the things that don't
// require network or LLM calls:
//   - Account hash algorithm (matches known testnet accounts)
//   - U512 / URef encoding
//   - Bincode serializer (round-trip + known vectors)
//   - Deploy hash computation (deterministic for fixed inputs)
//   - x402 challenge parsing

import { describe, expect, test } from 'bun:test';
import { computeAccountHash, decodePublicKey } from '../src/lib/casper/account-hash';
import {
  BincodeWriter,
  serializeU512CLValue,
  serializeURefCLValue,
  serializePublicKey,
  serializeDeployHeader,
  serializeModuleBytesPayment,
  serializeTransferSession,
} from '../src/lib/casper/bincode';
import {
  buildTransferDeploy,
  verifyDeployHash,
  encodeU512,
  encodeURef,
  parseTtlToMs,
} from '../src/lib/casper/deploy';
import { parseX402Challenge, encodePaymentProof, type X402PaymentProof } from '../src/lib/x402/client';
import { motesToCspr, csprToMotes, MOTES_PER_CSPR } from '../src/lib/utils/units';
import { blake2b } from '@noble/hashes/blake2b';

// ─── Account Hash ──────────────────────────────────────────────────────────

describe('account-hash', () => {
  const TREASURY_PUB = '02028689d1185c208db3f891098bb83ab3ddd79ac6512289d25911df1ff912fcf0b9';
  const TREASURY_HASH = 'account-hash-4373087ef51351ba91c7642907eab2c2e9bfe7d460eb1b4c2fe7e1475fc78e04';

  test('secp256k1 public key decodes to 33-byte compressed form', () => {
    const { algorithm, bytes } = decodePublicKey(TREASURY_PUB);
    expect(algorithm).toBe('secp256k1');
    expect(bytes.length).toBe(33);
    expect(bytes[0]).toBe(0x02); // parity byte
  });

  test('computes correct hash for the funded treasury account', () => {
    const hash = computeAccountHash(TREASURY_PUB);
    expect(hash).toBe(TREASURY_HASH);
  });

  test('hash format is account-hash-<64 hex chars>', () => {
    const hash = computeAccountHash(TREASURY_PUB);
    expect(hash).toMatch(/^account-hash-[0-9a-f]{64}$/);
  });

  test('rejects invalid algorithm prefix', () => {
    expect(() => computeAccountHash('03' + 'ab'.repeat(32))).toThrow(/Unknown algorithm prefix/);
  });

  test('rejects wrong key length', () => {
    expect(() => computeAccountHash('02' + 'ab'.repeat(30))).toThrow(/secp256k1 key body must be 33 bytes/);
  });
});

// ─── Unit conversions ──────────────────────────────────────────────────────

describe('units', () => {
  test('1 CSPR = 1e9 motes', () => {
    expect(MOTES_PER_CSPR).toBe(1_000_000_000n);
    expect(csprToMotes(1)).toBe(1_000_000_000n);
    expect(csprToMotes(0.05)).toBe(50_000_000n);
    expect(motesToCspr(1_000_000_000n)).toBe(1);
    expect(motesToCspr(50_000_000n)).toBeCloseTo(0.05, 10);
  });

  test('round-trips CSPR <-> motes', () => {
    const csprs = [0.001, 0.5, 1, 10, 100, 5000];
    for (const c of csprs) {
      const back = motesToCspr(csprToMotes(c));
      expect(back).toBeCloseTo(c, 6);
    }
  });
});

// ─── Bincode writer ────────────────────────────────────────────────────────

describe('BincodeWriter', () => {
  test('writeU8 / writeU16 / writeU32 / writeU64 round-trip', () => {
    const w = new BincodeWriter();
    w.writeU8(0xff).writeU16(0x1234).writeU32(0xdeadbeef).writeU64(0x123456789abcdefn);
    const buf = w.toBuffer();
    expect(buf.length).toBe(1 + 2 + 4 + 8);
    expect(buf[0]).toBe(0xff);
    expect(buf.readUInt16LE(1)).toBe(0x1234);
    expect(buf.readUInt32LE(3)).toBe(0xdeadbeef);
    expect(buf.readBigUInt64LE(7)).toBe(0x123456789abcdefn);
  });

  test('writeU512 encodes 0 as single zero byte', () => {
    const w = new BincodeWriter();
    w.writeU512(0n);
    expect(w.toBuffer()).toEqual(Buffer.from([0x00]));
  });

  test('writeU512 encodes 1 as length-1 LE byte', () => {
    const w = new BincodeWriter();
    w.writeU512(1n);
    expect(w.toBuffer()).toEqual(Buffer.from([0x01, 0x01]));
  });

  test('writeU512 encodes 256 as length-2 LE bytes', () => {
    const w = new BincodeWriter();
    w.writeU512(256n);
    // 256 = 0x0100 — LE: 00 01, length=2
    expect(w.toBuffer()).toEqual(Buffer.from([0x02, 0x00, 0x01]));
  });

  test('writeString encodes as 8-byte LE length + UTF-8 bytes', () => {
    const w = new BincodeWriter();
    w.writeString('casper-test');
    const buf = w.toBuffer();
    expect(buf.readBigUInt64LE(0)).toBe(11n);
    expect(buf.subarray(8).toString('utf-8')).toBe('casper-test');
  });

  test('writeVec matches writeString layout for byte arrays', () => {
    const w = new BincodeWriter();
    const data = Buffer.from('hello', 'utf-8');
    w.writeVec(data);
    const buf = w.toBuffer();
    expect(buf.readBigUInt64LE(0)).toBe(5n);
    expect(buf.subarray(8).toString('utf-8')).toBe('hello');
  });

  test('writeOption(None) writes single 0 byte', () => {
    const w = new BincodeWriter();
    w.writeOption(null, () => {});
    expect(w.toBuffer()).toEqual(Buffer.from([0x00]));
  });

  test('writeOption(Some) writes 1 + payload', () => {
    const w = new BincodeWriter();
    w.writeOption(42, (v) => w.writeU32(v));
    expect(w.toBuffer()).toEqual(Buffer.from([0x01, 0x2a, 0x00, 0x00, 0x00]));
  });
});

// ─── Deploy construction ───────────────────────────────────────────────────

describe('deploy', () => {
  const TREASURY_PUB = '02028689d1185c208db3f891098bb83ab3ddd79ac6512289d25911df1ff912fcf0b9';
  const SOURCE_PURSE = 'uref-f00cce9b099ffcd9ec321873a98cab8f19bdf9e40b9c79bb86690a8edc09b902-007';

  test('encodeU512 produces correct bytes + parsed', () => {
    const v = encodeU512(50_000_000n); // 0.05 CSPR
    expect(v.parsed).toBe('50000000');
    // 50M = 0x02FAF080 → LE bytes: 80 f0 fa 02, length=4
    expect(v.bytes).toBe('04' + '80f0fa02');
    expect(v.cl_type).toBe('U512');
  });

  test('encodeURef produces correct bytes + parsed', () => {
    const v = encodeURef(SOURCE_PURSE);
    // 32-byte addr + 1-byte access (0x07)
    expect(v.bytes.length).toBe(66); // 66 hex chars = 33 bytes
    expect(v.bytes.endsWith('07')).toBe(true);
    expect(v.parsed).toBe(SOURCE_PURSE);
  });

  test('encodeU512 rejects negative amounts', () => {
    expect(() => encodeU512(-1n)).toThrow(/cannot be negative/);
  });

  test('encodeURef rejects malformed urefs', () => {
    expect(() => encodeURef('not-a-uref')).toThrow(/invalid URef/);
    expect(() => encodeURef('uref-deadbeef-007')).toThrow(/invalid URef/);
  });

  test('parseTtlToMs converts units correctly', () => {
    expect(parseTtlToMs('30m')).toBe(1_800_000n);
    expect(parseTtlToMs('1h')).toBe(3_600_000n);
    expect(parseTtlToMs('600s')).toBe(600_000n);
    expect(parseTtlToMs('500ms')).toBe(500n);
    expect(() => parseTtlToMs('5d')).toThrow(/Invalid TTL/);
  });

  test('buildTransferDeploy produces deterministic hash for fixed inputs', () => {
    // Same inputs → same deploy_hash (deterministic)
    const params = {
      fromPublicKey: TREASURY_PUB,
      sourcePurse: SOURCE_PURSE,
      targetPurse: SOURCE_PURSE, // self-transfer for testing
      amountMotes: 50_000_000n,
      gasPaymentMotes: 0n,
      gasPrice: 1,
      ttl: '30m',
      chainName: 'casper-test',
      timestamp: new Date('2026-07-17T00:00:00.000Z'),
      argId: null,
    };
    const d1 = buildTransferDeploy(params);
    const d2 = buildTransferDeploy(params);
    expect(d1.hash).toBe(d2.hash);
    expect(d1.header.body_hash).toBe(d2.header.body_hash);
    expect(d1.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(d1.header.body_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('different amounts produce different deploy hashes', () => {
    const base = {
      fromPublicKey: TREASURY_PUB,
      sourcePurse: SOURCE_PURSE,
      targetPurse: SOURCE_PURSE,
      gasPaymentMotes: 0n,
      gasPrice: 1,
      ttl: '30m',
      chainName: 'casper-test',
      timestamp: new Date('2026-07-17T00:00:00.000Z'),
      argId: null,
    };
    const d1 = buildTransferDeploy({ ...base, amountMotes: 50_000_000n });
    const d2 = buildTransferDeploy({ ...base, amountMotes: 100_000_000n });
    expect(d1.hash).not.toBe(d2.hash);
    expect(d1.header.body_hash).not.toBe(d2.header.body_hash);
  });

  test('verifyDeployHash round-trips a freshly built deploy', () => {
    const d = buildTransferDeploy({
      fromPublicKey: TREASURY_PUB,
      sourcePurse: SOURCE_PURSE,
      targetPurse: SOURCE_PURSE,
      amountMotes: 50_000_000n,
      timestamp: new Date('2026-07-17T00:00:00.000Z'),
    });
    const v = verifyDeployHash(d);
    expect(v.matches).toBe(true);
    expect(v.computed).toBe(v.stored);
  });

  test('unsigned deploy has empty approvals', () => {
    const d = buildTransferDeploy({
      fromPublicKey: TREASURY_PUB,
      sourcePurse: SOURCE_PURSE,
      targetPurse: SOURCE_PURSE,
      amountMotes: 50_000_000n,
    });
    expect(d.approvals).toEqual([]);
  });

  test('deploy JSON has expected shape', () => {
    const d = buildTransferDeploy({
      fromPublicKey: TREASURY_PUB,
      sourcePurse: SOURCE_PURSE,
      targetPurse: SOURCE_PURSE,
      amountMotes: 50_000_000n,
    });
    expect(d.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.header.account).toBe(TREASURY_PUB);
    expect(d.header.chain_name).toBe('casper-test');
    expect(d.header.ttl).toBe('30m');
    expect(d.header.gas_price).toBe(1);
    expect(d.payment.Standard.payment_args).toHaveLength(1);
    expect(d.session.Transfer.args).toHaveLength(4);
    expect(d.session.Transfer.args[0][0]).toBe('amount');
    expect(d.session.Transfer.args[1][0]).toBe('source');
    expect(d.session.Transfer.args[2][0]).toBe('target');
    expect(d.session.Transfer.args[3][0]).toBe('arg_id');
  });
});

// ─── x402 parsing ──────────────────────────────────────────────────────────

describe('x402', () => {
  test('parses base64url-encoded requirements', () => {
    const reqs = {
      network: 'casper-test',
      asset: 'cspr',
      amount: '50000000',
      to: 'account-hash-4373087ef51351ba91c7642907eab2c2e9bfe7d460eb1b4c2fe7e1475fc78e04',
      description: 'Test payment',
      nonce: 'abc123',
    };
    const b64 = Buffer.from(JSON.stringify(reqs)).toString('base64url');
    const wwwAuth = `x402 requirements="${b64}"`;
    const challenge = parseX402Challenge(wwwAuth);
    expect(challenge.scheme).toBe('x402');
    expect(challenge.requirements.network).toBe('casper-test');
    expect(challenge.requirements.amount).toBe('50000000');
    expect(challenge.requirements.to).toBe(reqs.to);
  });

  test('parses inline key=value params', () => {
    const wwwAuth = `x402 network="casper-test",asset="cspr",amount="1000",to="account-hash-deadbeef"`;
    const challenge = parseX402Challenge(wwwAuth);
    expect(challenge.scheme).toBe('x402');
    expect(challenge.requirements.network).toBe('casper-test');
    expect(challenge.requirements.amount).toBe('1000');
  });

  test('encodePaymentProof round-trips via base64url', () => {
    const proof: X402PaymentProof = {
      network: 'casper-test',
      deploy_hash: 'deadbeef'.repeat(8),
      from: '02' + 'ab'.repeat(33),
      to: 'account-hash-' + '00'.repeat(32),
      amount: '50000000',
      asset: 'cspr',
      timestamp: '2026-07-17T00:00:00.000Z',
    };
    const encoded = encodePaymentProof(proof);
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
    expect(decoded).toEqual(proof);
  });
});

// ─── CLValue bincode serialization ─────────────────────────────────────────

describe('CLValue bincode', () => {
  test('serializeU512CLValue produces { bytes: Vec<u8>, cl_type: U512 }', () => {
    const w = new BincodeWriter();
    serializeU512CLValue(50_000_000n, w);
    const buf = w.toBuffer();
    // Vec<u8> length (8 bytes LE) + bytes (1 length + 4 LE bytes) + cl_type (4 bytes LE = 8)
    const vecLen = buf.readBigUInt64LE(0);
    expect(vecLen).toBe(5n); // 1 length byte + 4 value bytes
    const clTypeDiscriminant = buf.readUInt32LE(8 + 5);
    expect(clTypeDiscriminant).toBe(8); // U512
  });

  test('serializeURefCLValue produces 33-byte payload', () => {
    const w = new BincodeWriter();
    serializeURefCLValue('uref-f00cce9b099ffcd9ec321873a98cab8f19bdf9e40b9c79bb86690a8edc09b902-007', w);
    const buf = w.toBuffer();
    const vecLen = buf.readBigUInt64LE(0);
    expect(vecLen).toBe(33n); // 32-byte addr + 1-byte access
  });

  test('serializePublicKey encodes secp256k1 with discriminant 2', () => {
    const w = new BincodeWriter();
    serializePublicKey('02028689d1185c208db3f891098bb83ab3ddd79ac6512289d25911df1ff912fcf0b9', w);
    const buf = w.toBuffer();
    const disc = buf.readUInt32LE(0);
    expect(disc).toBe(2); // secp256k1 variant
    // After discriminant: 33-byte compressed key
    expect(buf.length).toBe(4 + 33);
    expect(buf[4]).toBe(0x02); // parity byte of compressed key
  });

  test('serializeModuleBytesPayment produces empty module_bytes + 1 arg', () => {
    const w = new BincodeWriter();
    serializeModuleBytesPayment(0n, w);
    const buf = w.toBuffer();
    // 4 bytes discriminant + 8 bytes module_bytes len (0) + 8 bytes args len (1) + arg...
    expect(buf.readUInt32LE(0)).toBe(0); // ModuleBytes variant
    expect(buf.readBigUInt64LE(4)).toBe(0n); // empty module_bytes
    expect(buf.readBigUInt64LE(12)).toBe(1n); // 1 RuntimeArg
  });

  test('serializeTransferSession produces Transfer variant with 4 args', () => {
    const w = new BincodeWriter();
    serializeTransferSession({
      amountMotes: 50_000_000n,
      sourcePurse: 'uref-f00cce9b099ffcd9ec321873a98cab8f19bdf9e40b9c79bb86690a8edc09b902-007',
      targetPurse: 'uref-f00cce9b099ffcd9ec321873a98cab8f19bdf9e40b9c79bb86690a8edc09b902-007',
      argId: null,
    }, w);
    const buf = w.toBuffer();
    expect(buf.readUInt32LE(0)).toBe(1); // Transfer variant
    expect(buf.readBigUInt64LE(4)).toBe(4n); // 4 RuntimeArgs
  });
});

// ─── blake2b sanity ─────────────────────────────────────────────────────────

describe('blake2b', () => {
  test('produces 32-byte digest', () => {
    const hash = blake2b(Buffer.from('hello'), { dkLen: 32 });
    expect(hash.length).toBe(32);
  });

  test('deterministic for same input', () => {
    const a = blake2b(Buffer.from('agentpay'), { dkLen: 32 });
    const b = blake2b(Buffer.from('agentpay'), { dkLen: 32 });
    expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
  });

  test('different for different inputs', () => {
    const a = blake2b(Buffer.from('hello'), { dkLen: 32 });
    const b = blake2b(Buffer.from('world'), { dkLen: 32 });
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });
});
