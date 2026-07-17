// Casper bincode serializer — produces the exact byte sequence that
// casper-node uses to compute deploy body_hash and deploy_hash.
//
// Rust bincode default config (used by casper-node):
//   - Little-endian
//   - Fixed-width integers (1/2/4/8 bytes per type)
//   - Sequences and strings prefixed with 8-byte LE length
//   - Enums tagged with 4-byte LE discriminant
//   - Options as 1-byte tag (0=None, 1=Some) + value
//   - Bools as 1 byte (0 or 1)
//   - Tuples serialized in order with no separator
//   - Structs serialized as tuples in declaration order
//
// References:
//   - https://docs.rs/bincode/latest/bincode/config/struct.Configuration.html
//   - casper-node v2.0.0 types/src/deploy/deploy.rs

// ─── Writer ────────────────────────────────────────────────────────────────

export class BincodeWriter {
  private chunks: Buffer[] = [];

  writeByte(b: number): this {
    this.chunks.push(Buffer.from([b & 0xff]));
    return this;
  }

  writeBytes(bytes: Uint8Array): this {
    this.chunks.push(Buffer.from(bytes));
    return this;
  }

  writeU8(n: number): this { return this.writeByte(n); }
  writeU16(n: number): this {
    const b = Buffer.alloc(2); b.writeUInt16LE(n >>> 0); this.chunks.push(b); return this;
  }
  writeU32(n: number): this {
    const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); this.chunks.push(b); return this;
  }
  writeU64(n: bigint): this {
    const b = Buffer.alloc(8); b.writeBigUInt64LE(n); this.chunks.push(b); return this;
  }

  /** Variable-length U512: 1-byte length prefix + little-endian bytes */
  writeU512(n: bigint): this {
    if (n < 0n) throw new Error('U512 cannot be negative');
    if (n === 0n) { this.writeByte(0); return this; }
    let hex = n.toString(16);
    if (hex.length % 2 !== 0) hex = '0' + hex;
    const bytesLE = Buffer.from(hex, 'hex').reverse(); // LE byte order
    this.writeByte(bytesLE.length);
    this.chunks.push(bytesLE);
    return this;
  }

  /** Length-prefixed (8-byte LE) byte vector */
  writeVec(bytes: Uint8Array): this {
    this.writeU64(BigInt(bytes.length));
    this.chunks.push(Buffer.from(bytes));
    return this;
  }

  /** Length-prefixed (8-byte LE) UTF-8 string */
  writeString(s: string): this {
    this.writeVec(Buffer.from(s, 'utf-8'));
    return this;
  }

  /** Option<T>: 1-byte tag + value if Some */
  writeOption<T>(val: T | null | undefined, writeVal: (v: T) => void): this {
    if (val === null || val === undefined) { this.writeByte(0); return this; }
    this.writeByte(1);
    writeVal(val);
    return this;
  }

  /** Bool: 1 byte */
  writeBool(b: boolean): this {
    this.writeByte(b ? 1 : 0);
    return this;
  }

  /** Enum: 4-byte LE discriminant + payload */
  writeEnumVariant(discriminant: number, writePayload: () => void): this {
    this.writeU32(discriminant);
    writePayload();
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }

  toHex(): string {
    return this.toBuffer().toString('hex');
  }
}

// ─── Casper type serializers ───────────────────────────────────────────────

/**
 * Serialize a Casper PublicKey.
 *
 * Enum PublicKey { System, Ed25519(PublicKeyEd25519), Secp256k1(PublicKeySecp256k1) }
 *
 * Serializes as:
 *   - 4-byte LE discriminant (0=System, 1=Ed25519, 2=Secp256k1)
 *   - For Ed25519: 32-byte raw key
 *   - For Secp256k1: 33-byte compressed key (with 02/03 parity)
 *
 * Input format: Casper public key hex WITH algorithm tag prefix:
 *   - 01 + 32 bytes (Ed25519)
 *   - 02 + 33 bytes (Secp256k1)
 */
export function serializePublicKey(publicKeyHex: string, w: BincodeWriter): void {
  const clean = publicKeyHex.replace(/^0x/, '').toLowerCase();
  const tag = clean.slice(0, 2);
  const body = Buffer.from(clean.slice(2), 'hex');
  if (tag === '01') {
    if (body.length !== 32) throw new Error(`Ed25519 key must be 32 bytes (got ${body.length})`);
    w.writeU32(1);
    w.writeBytes(body);
  } else if (tag === '02') {
    if (body.length !== 33) throw new Error(`secp256k1 key must be 33 bytes (got ${body.length})`);
    w.writeU32(2);
    w.writeBytes(body);
  } else {
    throw new Error(`Unknown public key tag: ${tag}`);
  }
}

/**
 * Serialize an account_hash (32-byte digest, no prefix).
 * Input: "account-hash-<64 hex chars>"
 */
export function serializeAccountHash(accountHash: string, w: BincodeWriter): void {
  const m = accountHash.match(/^account-hash-([0-9a-fA-F]{64})$/);
  if (!m) throw new Error(`Invalid account hash: ${accountHash}`);
  w.writeBytes(Buffer.from(m[1], 'hex'));
}

/**
 * Serialize a URef (32-byte address + 1-byte access rights).
 * Input: "uref-<64 hex chars>-<3 digits>"
 */
export function serializeURef(uref: string, w: BincodeWriter): void {
  const m = uref.match(/^uref-([0-9a-fA-F]{64})-(\d{3})$/);
  if (!m) throw new Error(`Invalid URef: ${uref}`);
  const addr = Buffer.from(m[1], 'hex');
  const access = parseInt(m[2], 10) & 0xff;
  w.writeBytes(addr);
  w.writeByte(access);
}

/**
 * Serialize a deploy Hash (32-byte digest, no prefix).
 * Input: 64-char hex string.
 */
export function serializeDeployHash(hashHex: string, w: BincodeWriter): void {
  const clean = hashHex.replace(/^0x/, '').toLowerCase();
  if (clean.length !== 64) throw new Error(`Deploy hash must be 32 bytes (got ${clean.length / 2})`);
  w.writeBytes(Buffer.from(clean, 'hex'));
}

/**
 * Serialize a Casper DeployHeader.
 *
 * Struct DeployHeader {
 *   account: PublicKey,
 *   timestamp: TimestampMs (u64 LE millis since unix epoch),
 *   ttl: TimeDiff (u64 LE milliseconds),
 *   gas_price: u64 LE,
 *   body_hash: Digest (32 bytes),
 *   dependencies: Vec<DeployHash> (length-prefixed list of 32-byte hashes),
 *   chain_name: String,
 * }
 *
 * Note: For the body_hash computation, the body_hash inside the header is
 * zero-filled. For the deploy_hash computation, the body_hash is the
 * already-computed blake2b256 of the deploy body.
 */
export interface DeployHeaderInput {
  account: string;
  timestamp: Date;
  ttlMs: bigint;
  gasPrice: number;
  bodyHash: string; // 64-char hex (zero-filled for body_hash step)
  dependencies: string[];
  chainName: string;
}

export function serializeDeployHeader(input: DeployHeaderInput, w: BincodeWriter): void {
  serializePublicKey(input.account, w);
  w.writeU64(BigInt(input.timestamp.getTime()));
  w.writeU64(input.ttlMs);
  w.writeU64(BigInt(input.gasPrice));
  // body_hash: 32 bytes (Digest)
  const bh = input.bodyHash.replace(/^0x/, '').toLowerCase();
  if (bh.length !== 64) throw new Error(`body_hash must be 32 bytes (got ${bh.length / 2})`);
  w.writeBytes(Buffer.from(bh, 'hex'));
  // dependencies: Vec<DeployHash>
  w.writeU64(BigInt(input.dependencies.length));
  for (const dep of input.dependencies) {
    serializeDeployHash(dep, w);
  }
  // chain_name: String
  w.writeString(input.chainName);
}

/**
 * Serialize a Casper Deploy body — the input to body_hash.
 *
 * For a native transfer deploy:
 *   body_hash = blake2b256(serializeDeployBody(payment, session))
 *
 * The body is a tuple (payment, session). For Casper 2.0 (V2):
 *   payment: ExecutableDeployItem::ModuleBytes | Transfer | SmartContract
 *   For native transfers, payment is ExecutableDeployItem::ModuleBytes with
 *   an empty module_bytes and a single arg "amount" (the gas payment).
 *   session: ExecutableDeployItem::Transfer
 *
 * However, for simplicity and matching the casper-node V1/V2 deploy format
 * actually accepted by account_put_deploy, we use the V1 Deploy format
 * (legacy compatibility is preserved on testnet).
 *
 * ExecutableDeployItem enum:
 *   0 = ModuleBytes
 *   1 = Transfer
 *   2 = StoredContractByHash
 *   3 = StoredContractByName
 *   4 = StoredVersionedContractByHash
 *   5 = StoredVersionedContractByName
 *
 * Variants serialize as:
 *   ModuleBytes: { module_bytes: Vec<u8>, args: RuntimeArgs }
 *   Transfer:    { args: RuntimeArgs }
 *
 * RuntimeArgs = Vec<(String, CLValue)>
 *   Serialized as: 8-byte LE length + (String name, CLValue value) pairs
 *
 * CLValue = { cl_type: CLType, bytes: Vec<u8> }
 *   Serialized as: bytes (Vec<u8> length-prefixed) + cl_type
 *   NOTE: cl_type comes AFTER bytes in bincode serialization!
 *
 * CLType enum variants:
 *   0=Bool, 1=I32, 2=I64, 3=U8, 4=U32, 5=U64, 6=U128, 7=U256, 8=U512,
 *   9=Unit, 10=String, 11=Key, 12=URef, 13=Option, 14=List, 15=ByteArray,
 *   16=Result, 17=Map, 18=Tuple1, 19=Tuple2, 20=Tuple3, 21=Any
 */

// CLType discriminants
export const CL_TYPE = {
  Bool: 0, I32: 1, I64: 2, U8: 3, U32: 4, U64: 5,
  U128: 6, U256: 7, U512: 8, Unit: 9, String: 10,
  Key: 11, URef: 12, Option: 13, List: 14, ByteArray: 15,
  Result: 16, Map: 17, Tuple1: 18, Tuple2: 19, Tuple3: 20, Any: 21,
} as const;

/**
 * Serialize a CLValue as { bytes: Vec<u8>, cl_type: CLType }.
 * The bytes are the serialized value in CLValue format, and the cl_type
 * is the type descriptor (enum).
 */
export function serializeCLValue(
  bytes: Uint8Array,
  clTypeDiscriminant: number,
  w: BincodeWriter,
): void {
  // bytes: Vec<u8>
  w.writeVec(bytes);
  // cl_type: CLType (enum discriminant)
  // For simple types, just write the discriminant.
  // For complex types (Option, List, Map, Tuple), additional data follows.
  w.writeU32(clTypeDiscriminant);
}

/**
 * Serialize a U512 CLValue (the most common one in transfers).
 * bytes = 1-byte length + LE bytes
 * cl_type = U512 (discriminant 8)
 */
export function serializeU512CLValue(n: bigint, w: BincodeWriter): void {
  // Build the bytes portion first
  const bytesW = new BincodeWriter();
  bytesW.writeU512(n);
  serializeCLValue(bytesW.toBuffer(), CL_TYPE.U512, w);
}

/**
 * Serialize a URef CLValue.
 * bytes = 32-byte address + 1-byte access rights
 * cl_type = URef (discriminant 12)
 */
export function serializeURefCLValue(uref: string, w: BincodeWriter): void {
  const bytesW = new BincodeWriter();
  serializeURef(uref, bytesW);
  serializeCLValue(bytesW.toBuffer(), CL_TYPE.URef, w);
}

/**
 * Serialize an Option<U64> CLValue.
 * bytes = 1-byte tag (0=None, 1=Some) + optional 8-byte LE
 * cl_type = Option (discriminant 13) + inner U64 (discriminant 5)
 */
export function serializeOptionU64CLValue(val: bigint | null, w: BincodeWriter): void {
  const bytesW = new BincodeWriter();
  if (val === null) {
    bytesW.writeByte(0);
  } else {
    bytesW.writeByte(1);
    bytesW.writeU64(val);
  }
  // cl_type = Option<U64> = 13 + 5 (inner type)
  w.writeVec(bytesW.toBuffer());
  w.writeU32(CL_TYPE.Option);
  w.writeU32(CL_TYPE.U64);
}

/**
 * RuntimeArgs = Vec<(String, CLValue)>
 */
export function serializeRuntimeArgs(
  args: Array<{ name: string; write: (w: BincodeWriter) => void }>,
  w: BincodeWriter,
): void {
  w.writeU64(BigInt(args.length));
  for (const arg of args) {
    w.writeString(arg.name);
    arg.write(w);
  }
}

/**
 * Serialize ExecutableDeployItem::ModuleBytes (empty module, gas payment args).
 * Used for the `payment` field of native transfer deploys.
 *
 * ModuleBytes {
 *   module_bytes: Vec<u8>,  // empty for native transfers
 *   args: RuntimeArgs,      // contains "amount" for gas payment
 * }
 */
export function serializeModuleBytesPayment(gasAmountMotes: bigint, w: BincodeWriter): void {
  w.writeU32(0); // discriminant for ModuleBytes
  w.writeVec(new Uint8Array(0)); // empty module_bytes
  serializeRuntimeArgs([{
    name: 'amount',
    write: (ww) => serializeU512CLValue(gasAmountMotes, ww),
  }], w);
}

/**
 * Serialize ExecutableDeployItem::Transfer.
 * Used for the `session` field of native transfer deploys.
 *
 * Transfer {
 *   args: RuntimeArgs,  // contains amount, source, target, arg_id
 * }
 */
export interface TransferArgs {
  amountMotes: bigint;
  sourcePurse: string; // uref
  targetPurse: string; // uref (or account hash wrapped in Key::URef? — see note)
  argId: bigint | null;
}

export function serializeTransferSession(args: TransferArgs, w: BincodeWriter): void {
  w.writeU32(1); // discriminant for Transfer
  serializeRuntimeArgs([
    { name: 'amount', write: (ww) => serializeU512CLValue(args.amountMotes, ww) },
    { name: 'source', write: (ww) => serializeURefCLValue(args.sourcePurse, ww) },
    { name: 'target', write: (ww) => serializeURefCLValue(args.targetPurse, ww) },
    { name: 'arg_id', write: (ww) => serializeOptionU64CLValue(args.argId, ww) },
  ], w);
}

// ─── Top-level deploy serialization ────────────────────────────────────────

/**
 * Serialize the deploy body — the input to body_hash.
 *
 * For Casper V1 deploys:
 *   body = (payment: ExecutableDeployItem, session: ExecutableDeployItem)
 *
 *   body_hash = blake2b256(body)
 *
 * This is just the tuple — no extra wrapping.
 */
export function serializeDeployBody(
  paymentBytes: Uint8Array,
  sessionBytes: Uint8Array,
  w: BincodeWriter,
): void {
  // Body is a tuple (payment, session). Tuples serialize as concatenation in bincode.
  w.writeBytes(paymentBytes);
  w.writeBytes(sessionBytes);
}

/**
 * Serialize the entire deploy — the input to deploy_hash.
 *
 * deploy_hash = blake2b256(serializeDeploy(header, payment, session))
 *
 * where the body_hash in the header is the ALREADY-COMPUTED hash of the body.
 *
 * For Casper V1:
 *   deploy = (header: DeployHeader, payment: ExecutableDeployItem, session: ExecutableDeployItem)
 *
 * (approvals are NOT part of deploy_hash)
 */
export function serializeDeployForHash(
  header: DeployHeaderInput,
  paymentBytes: Uint8Array,
  sessionBytes: Uint8Array,
  w: BincodeWriter,
): void {
  serializeDeployHeader(header, w);
  w.writeBytes(paymentBytes);
  w.writeBytes(sessionBytes);
}

/**
 * Serialize an approval for inclusion in the deploy's approvals array.
 *
 * Approval = { signer: PublicKey, signature: Signature }
 * Signature = Vec<u8> (length-prefixed)
 *
 * Serialized form:
 *   signer: PublicKey (enum + key bytes)
 *   signature: Vec<u8> (8-byte LE length + bytes)
 *
 * Note: The signature bytes themselves are prefixed with the algorithm tag byte:
 *   - Ed25519:   01 + 64-byte signature (65 bytes total)
 *   - Secp256k1: 02 + 64-byte signature (65 bytes total)
 */
export function serializeApproval(
  signerPublicKeyHex: string,
  signatureWithTag: string, // hex string with 0x01/0x02 prefix already
  w: BincodeWriter,
): void {
  serializePublicKey(signerPublicKeyHex, w);
  const sigBytes = Buffer.from(signatureWithTag, 'hex');
  w.writeVec(sigBytes);
}
