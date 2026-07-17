// Casper deploy construction (native transfers) with real bincode serialization.
//
// Produces Casper V1 deploys that can be submitted via `account_put_deploy`.
// The body_hash and deploy_hash are computed via blake2b256 over the exact
// bincode-encoded byte sequence that casper-node uses.

import { signDeployHash, formatApproval, type KeyPair } from './signing';
import { env } from '../env';
import { blake2b } from '@noble/hashes/blake2b';
import {
  BincodeWriter,
  serializeDeployHeader,
  serializeDeployBody,
  serializeDeployForHash,
  serializeModuleBytesPayment,
  serializeTransferSession,
  serializeApproval,
  type DeployHeaderInput,
} from './bincode';

// ─── JSON shape for account_put_deploy ─────────────────────────────────────

export interface DeployHeaderJson {
  account: string; // public key hex (with algo tag)
  timestamp: string; // ISO 8601 (millisecond precision)
  ttl: string; // e.g. "30m"
  gas_price: number;
  body_hash: string; // hex
  dependencies: string[];
  chain_name: string;
}

export interface TransferSessionJson {
  Transfer: {
    args: [
      ['amount', { cl_type: 'U512'; bytes: string; parsed: string }],
      ['source', { cl_type: 'URef'; bytes: string; parsed: string }],
      ['target', { cl_type: 'URef'; bytes: string; parsed: string }],
      ['arg_id', { cl_type: 'Option<U64>'; bytes: string; parsed: string | null }],
    ];
  };
}

export interface StandardPaymentJson {
  Standard: {
    payment_args: [['amount', { cl_type: 'U512'; bytes: string; parsed: string }]];
  };
}

export interface DeployJson {
  hash: string;
  header: DeployHeaderJson;
  payment: StandardPaymentJson;
  session: TransferSessionJson;
  approvals: { signer: string; signature: string }[];
}

// ─── CLValue encoders (for JSON representation) ────────────────────────────

export function encodeU512(amount: bigint): { cl_type: 'U512'; bytes: string; parsed: string } {
  if (amount < 0n) throw new Error('U512 cannot be negative');
  const hex = amount.toString(16);
  const padded = hex.length % 2 === 0 ? hex : '0' + hex;
  const bytes = Buffer.from(padded, 'hex').reverse(); // LE
  const lenByte = Buffer.from([bytes.length]);
  return {
    cl_type: 'U512',
    bytes: Buffer.concat([lenByte, bytes]).toString('hex'),
    parsed: amount.toString(),
  };
}

export function encodeURef(uref: string): { cl_type: 'URef'; bytes: string; parsed: string } {
  const m = uref.match(/^uref-([0-9a-f]{64})-(\d{3})$/i);
  if (!m) throw new Error(`invalid URef: ${uref}`);
  const bytes = Buffer.from(m[1], 'hex');
  const access = parseInt(m[2], 10);
  return {
    cl_type: 'URef',
    bytes: Buffer.concat([bytes, Buffer.from([access])]).toString('hex'),
    parsed: uref,
  };
}

// ─── TTL parsing ────────────────────────────────────────────────────────────

export function parseTtlToMs(ttl: string): bigint {
  const m = ttl.match(/^(\d+)(ms|s|m|h)$/);
  if (!m) throw new Error(`Invalid TTL format: ${ttl} (e.g. "30m", "1h", "600s")`);
  const n = parseInt(m[1], 10);
  const unit = m[2];
  switch (unit) {
    case 'ms': return BigInt(n);
    case 's':  return BigInt(n) * 1000n;
    case 'm':  return BigInt(n) * 60_000n;
    case 'h':  return BigInt(n) * 3_600_000n;
  }
  throw new Error(`Unreachable`);
}

// ─── Build params ───────────────────────────────────────────────────────────

export interface BuildTransferParams {
  fromPublicKey: string;
  sourcePurse: string;
  targetPurse: string;
  amountMotes: bigint;
  gasPrice?: number;
  gasPaymentMotes?: bigint; // usually 0 for transfers, default 0
  ttl?: string;              // default "30m"
  chainName?: string;
  timestamp?: Date;          // default now
  argId?: bigint | null;     // default null
}

// ─── Internal: serialize payment + session to bincode bytes ─────────────────

function serializePaymentBytes(gasAmountMotes: bigint): Uint8Array {
  const w = new BincodeWriter();
  serializeModuleBytesPayment(gasAmountMotes, w);
  return w.toBuffer();
}

function serializeSessionBytes(args: {
  amountMotes: bigint;
  sourcePurse: string;
  targetPurse: string;
  argId: bigint | null;
}): Uint8Array {
  const w = new BincodeWriter();
  serializeTransferSession(args, w);
  return w.toBuffer();
}

// ─── Build a fully-hashed deploy ────────────────────────────────────────────

/**
 * Build a native-transfer deploy with correct body_hash and deploy_hash,
 * computed via blake2b256 over bincode-serialized bytes.
 *
 * If keyPair is provided, also signs the deploy_hash and adds the approval.
 * If keyPair is null, the deploy is returned unsigned (useful for inspection
 * and dry-run scenarios).
 */
export function buildTransferDeploy(params: BuildTransferParams, keyPair?: KeyPair | null): DeployJson {
  const timestamp = params.timestamp ?? new Date();
  const ttl = params.ttl ?? '30m';
  const gasPrice = params.gasPrice ?? 1;
  const gasPayment = params.gasPaymentMotes ?? 0n;
  const chainName = params.chainName ?? env.casper.chainName;
  const argId = params.argId ?? null;

  // 1. Serialize payment + session bodies
  const paymentBytes = serializePaymentBytes(gasPayment);
  const sessionBytes = serializeSessionBytes({
    amountMotes: params.amountMotes,
    sourcePurse: params.sourcePurse,
    targetPurse: params.targetPurse,
    argId,
  });

  // 2. Compute body_hash = blake2b256(payment || session)
  const bodyW = new BincodeWriter();
  serializeDeployBody(paymentBytes, sessionBytes, bodyW);
  const bodyHashBytes = blake2b(bodyW.toBuffer(), { dkLen: 32 });
  const bodyHashHex = Buffer.from(bodyHashBytes).toString('hex');

  // 3. Build header input (with computed body_hash) and serialize for deploy_hash
  const headerInput: DeployHeaderInput = {
    account: params.fromPublicKey,
    timestamp,
    ttlMs: parseTtlToMs(ttl),
    gasPrice,
    bodyHash: bodyHashHex,
    dependencies: [],
    chainName,
  };
  const deployW = new BincodeWriter();
  serializeDeployForHash(headerInput, paymentBytes, sessionBytes, deployW);
  const deployHashBytes = blake2b(deployW.toBuffer(), { dkLen: 32 });
  const deployHashHex = Buffer.from(deployHashBytes).toString('hex');

  // 4. Build JSON structure
  const deploy: DeployJson = {
    hash: deployHashHex,
    header: {
      account: params.fromPublicKey,
      timestamp: timestamp.toISOString(),
      ttl,
      gas_price: gasPrice,
      body_hash: bodyHashHex,
      dependencies: [],
      chain_name: chainName,
    },
    payment: {
      Standard: {
        payment_args: [['amount', encodeU512(gasPayment)]],
      },
    },
    session: {
      Transfer: {
        args: [
          ['amount', encodeU512(params.amountMotes)],
          ['source', encodeURef(params.sourcePurse)],
          ['target', encodeURef(params.targetPurse)],
          ['arg_id', { cl_type: 'Option<U64>', bytes: '00', parsed: null }],
        ],
      },
    },
    approvals: [],
  };

  // 5. Sign if key provided
  if (keyPair) {
    const sig = signDeployHash(deployHashBytes, keyPair.privateKey, keyPair.algorithm);
    const approval = formatApproval(keyPair.publicKeyHex, sig);
    deploy.approvals.push(approval);
  }

  return deploy;
}

/**
 * Add an approval signature to an existing deploy.
 * Returns a new deploy object with the approval appended.
 */
export function signDeploy(
  deploy: DeployJson,
  deployHashBytes: Uint8Array,
  keyPair: KeyPair,
): DeployJson {
  const sig = signDeployHash(deployHashBytes, keyPair.privateKey, keyPair.algorithm);
  const approval = formatApproval(keyPair.publicKeyHex, sig);
  return {
    ...deploy,
    approvals: [...deploy.approvals, approval],
  };
}

// ─── Verification ───────────────────────────────────────────────────────────

/**
 * Recompute the deploy_hash from a DeployJson and compare with .hash.
 * Useful for round-trip verification after JSON serialization.
 */
export function verifyDeployHash(deploy: DeployJson): { matches: boolean; computed: string; stored: string } {
  // Reconstruct the bytes from the JSON
  const gasAmount = BigInt(deploy.payment.Standard.payment_args[0][1].parsed);
  const sessionArgs = deploy.session.Transfer.args;
  const amountMotes = BigInt(sessionArgs[0][1].parsed);
  const sourcePurse = sessionArgs[1][1].parsed;
  const targetPurse = sessionArgs[2][1].parsed;

  const paymentBytes = serializePaymentBytes(gasAmount);
  const sessionBytes = serializeSessionBytes({
    amountMotes,
    sourcePurse,
    targetPurse,
    argId: null,
  });

  const headerInput: DeployHeaderInput = {
    account: deploy.header.account,
    timestamp: new Date(deploy.header.timestamp),
    ttlMs: parseTtlToMs(deploy.header.ttl),
    gasPrice: deploy.header.gas_price,
    bodyHash: deploy.header.body_hash,
    dependencies: deploy.header.dependencies,
    chainName: deploy.header.chain_name,
  };
  const w = new BincodeWriter();
  serializeDeployForHash(headerInput, paymentBytes, sessionBytes, w);
  const computed = Buffer.from(blake2b(w.toBuffer(), { dkLen: 32 })).toString('hex');
  return { matches: computed === deploy.hash, computed, stored: deploy.hash };
}

/**
 * Serialize the entire deploy (with approvals) to bincode — useful for
 * computing the canonical byte representation that goes over the wire
 * to account_put_deploy.
 *
 * The JSON form is what account_put_deploy accepts, so this is mainly
 * for verification and testing.
 */
export function serializeFullDeploy(deploy: DeployJson): Uint8Array {
  const w = new BincodeWriter();
  // Header
  serializeDeployHeader({
    account: deploy.header.account,
    timestamp: new Date(deploy.header.timestamp),
    ttlMs: parseTtlToMs(deploy.header.ttl),
    gasPrice: deploy.header.gas_price,
    bodyHash: deploy.header.body_hash,
    dependencies: deploy.header.dependencies,
    chainName: deploy.header.chain_name,
  }, w);
  // Payment + session bytes (re-serialize)
  const gasAmount = BigInt(deploy.payment.Standard.payment_args[0][1].parsed);
  const sessionArgs = deploy.session.Transfer.args;
  const paymentBytes = serializePaymentBytes(gasAmount);
  const sessionBytes = serializeSessionBytes({
    amountMotes: BigInt(sessionArgs[0][1].parsed),
    sourcePurse: sessionArgs[1][1].parsed,
    targetPurse: sessionArgs[2][1].parsed,
    argId: null,
  });
  w.writeBytes(paymentBytes);
  w.writeBytes(sessionBytes);
  // Approvals: Vec<Approval>
  w.writeU64(BigInt(deploy.approvals.length));
  for (const ap of deploy.approvals) {
    serializeApproval(ap.signer, ap.signature, w);
  }
  return w.toBuffer();
}

// Backwards-compat: expose Deploy alias.
export type Deploy = DeployJson;
