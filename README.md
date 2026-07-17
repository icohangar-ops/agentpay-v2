# AgentPay

**An x402-protocol payment layer for AI agents on the Casper blockchain, with a GLM-4.6-powered Treasury Agent that makes on-chain spending decisions.**

> BUIDL submission for the Casper x Z.ai hackathon · DoraHacks · submit before 2026-07-26

---

## What it does

AI agents increasingly need to pay for API calls (web search, LLM completions, image generation, data scraping). Today this requires either (a) pre-funded centralized accounts at every vendor, or (b) humans in the loop for every purchase. **AgentPay** fixes this with a single on-chain treasury that an LLM agent manages autonomously.

The flow:

1. An AI agent calls an x402-protected API endpoint.
2. The service replies with HTTP **402 Payment Required** + a `WWW-Authenticate: x402` header describing the network, asset, amount, and recipient.
3. The **Treasury Agent** receives the challenge and runs a 2-stage decision pipeline:
   - **Policy engine** (deterministic, ~1ms) — block list, balance check, budget check, auto-approve for trusted services under threshold.
   - **GLM-4.6 LLM review** (~2-3s) — if the policy doesn't auto-decide, the LLM weighs trust score, mission value, recent spend history, and returns a strict-JSON verdict.
4. Verdict is one of `APPROVE` / `DENY` / `DEFER` / `COUNTER`. Every decision (auto or LLM) is persisted to a SQLite audit log.
5. On `APPROVE`, a Casper native-transfer deploy is constructed (bincode-serialized, blake2b256-hashed), signed with the treasury's secp256k1 key, and submitted via `account_put_deploy`.

## Architecture

![Architecture diagram](./download/agentpay-architecture.png)

The diagram lives at `download/agentpay-architecture.png` (relative to project root). Key components:

| Layer | File | Responsibility |
|---|---|---|
| Casper RPC | `src/lib/casper/rpc.ts` | JSON-RPC client (`state_get_account_info`, `state_get_balance`, `account_put_deploy`, `info_get_deploy`) |
| Account hash | `src/lib/casper/account-hash.ts` | Blake2b-256 account hash (matches testnet for both Ed25519 and secp256k1) |
| Bincode serializer | `src/lib/casper/bincode.ts` | Rust bincode-compatible writer for deploy body + header |
| Deploy builder | `src/lib/casper/deploy.ts` | Native transfer deploys with real `body_hash` and `deploy_hash` |
| Signing | `src/lib/casper/signing.ts` | Ed25519 + secp256k1 deploy-hash signing (compact, low-s) |
| x402 client | `src/lib/x402/client.ts` | Parse `WWW-Authenticate`, encode `X-PAYMENT` proof |
| Treasury Agent | `src/lib/treasury/agent.ts` | The ~530 LOC decision engine |
| Persistence | `prisma/schema.prisma` | 5 models: `TreasuryConfig`, `TreasuryDecision`, `TreasurySpend`, `X402Service`, `AgentIdentity` |

## Demo (live, on casper-test)

The treasury account is **funded with 5000 CSPR** on the Casper testnet:

- **Public key:** `02028689d1185c208db3f891098bb83ab3ddd79ac6512289d25911df1ff912fcf0b9` (secp256k1)
- **Account hash:** `account-hash-4373087ef51351ba91c7642907eab2c2e9bfe7d460eb1b4c2fe7e1475fc78e04`
- **Main purse:** `uref-f00cce9b099ffcd9ec321873a98cab8f19bdf9e40b9c79bb86690a8edc09b902-007`
- **Explorer:** https://testnet.cspr.live/account/02028689d1185c208db3f891098bb83ab3ddd79ac6512289d25911df1ff912fcf0b9

Running `bun run scripts/demo-treasury.ts` walks through four scenarios:

| Scenario | Service trust | Amount | Expected | Actual |
|---|---|---|---|---|
| Trusted search API, small amount | 85 | 0.05 CSPR | Auto-approve | ✅ APPROVE (policy, ~1s) |
| Review-required LLM call | 70 | 0.50 CSPR | LLM decides | ✅ APPROVE (GLM-4.6, ~3s) |
| Low-trust scraper | 25 | 0.10 CSPR | LLM skeptical | ✅ DENY (GLM-4.6, ~3s) |
| Blocked malware feed | 5 | 0.01 CSPR | Auto-deny | ✅ DENY (policy, ~1s) |

For each `APPROVE`, the demo also constructs a real Casper deploy — bincode-serialized body, blake2b256 body_hash and deploy_hash computed correctly, ready to sign and submit.

### Demo artifacts

All demo outputs live in `download/`:

| File | What |
|---|---|
| `agentpay-architecture.png` | System architecture diagram (4-phase flow) |
| `agentpay-demo.png` | Syntax-highlighted transcript of the live demo |
| `agentpay-demo.cast` | Asciinema recording (replay with `asciinema play download/agentpay-demo.cast`) |
| `agentpay-demo-transcript.txt` | Raw text output of the demo |

## Stack

- **Runtime:** [Bun](https://bun.sh) 1.x (TypeScript-native)
- **Blockchain:** Casper testnet (casper-test chain name, RPC at `node.testnet.casper.network/rpc`)
- **Cryptography:** `@noble/hashes` (blake2b, sha256) + `@noble/curves` (secp256k1, ed25519)
- **Database:** SQLite via Prisma ORM
- **LLM:** GLM-4.6 via `z-ai-web-dev-sdk` (the SDK handles API key automatically)
- **Payment protocol:** x402 (HTTP 402 + WWW-Authenticate header)

## Quick start

```bash
cd /home/z/my-project/agentpay

# 1. Install deps
bun install

# 2. Push the Prisma schema to SQLite
bunx prisma db push

# 3. Verify the funded treasury account on testnet
bun run scripts/check-account.ts

# 4. Run the end-to-end demo (decision-only mode, no private key needed)
bun run scripts/demo-treasury.ts

# 5. Run unit tests
bun test
```

## Configuration

All config lives in `.env.local`:

```bash
CASPER_RPC_URL="https://node.testnet.casper.network/rpc"
CASPER_CHAIN_NAME="casper-test"
CASPER_TREASURY_PUBLIC_KEY="02028689d1185c208db3f891098bb83ab3ddd79ac6512289d25911df1ff912fcf0b9"
CASPER_TREASURY_PRIVATE_KEY=""   # leave empty for decision-only mode
DATABASE_URL="file:./db/dev.db"
GLM_MODEL="glm-4.6"
```

## How the LLM decision works

The Treasury Agent calls GLM-4.6 with a structured prompt containing:

- The payment request (amount, recipient, service, task context)
- The treasury state (balance, hourly/daily spend so far, agent budget)
- The service trust score and policy
- The 5 most recent decisions for this agent

The LLM is instructed to return **strict JSON only**:

```json
{
  "verdict": "APPROVE",
  "approved_amount_motes": "500000000",
  "counter_amount_motes": null,
  "rationale": "The request is within all budget constraints...",
  "next_step": "Proceed with the GPT-4 completion request."
}
```

The agent parses this, falls back to `DEFER` if the LLM output is malformed, and persists the raw LLM response alongside the structured decision for audit purposes.

## How the on-chain payment works

A Casper native transfer deploy consists of:

1. **Payment** — `ExecutableDeployItem::ModuleBytes` with empty `module_bytes` and a single arg `amount` (gas payment, 0 for transfers).
2. **Session** — `ExecutableDeployItem::Transfer` with args `amount`, `source` (URef), `target` (URef), `arg_id` (Option&lt;U64&gt;).
3. **Header** — account, timestamp, ttl, gas_price, body_hash, dependencies, chain_name.
4. **Approvals** — `{ signer, signature }` array, signed over `deploy_hash`.

The hashes are computed via:

```
body_hash    = blake2b256( bincode(payment) || bincode(session) )
deploy_hash  = blake2b256( bincode(header)  || bincode(payment) || bincode(session) )
```

We implemented the bincode serializer from scratch in `src/lib/casper/bincode.ts` because Casper's serialization format (Rust bincode default config: little-endian, 8-byte LE length prefixes, 4-byte LE enum discriminants) is not available in any npm package. The implementation is verified by `verifyDeployHash()` which recomputes the hash from the JSON form and confirms it matches.

## Test coverage

36 unit tests in `tests/core.test.ts`:

- Account hash algorithm (matches the funded treasury account on testnet)
- Bincode writer primitives (U8/U16/U32/U64, U512, Vec, String, Option)
- CLValue serialization (U512, URef, Option&lt;U64&gt;, PublicKey)
- Deploy construction (deterministic hash for fixed inputs, different hashes for different amounts)
- `verifyDeployHash` round-trip
- x402 challenge parsing (base64url + inline params)
- Payment proof encoding round-trip
- Unit conversions (motes ↔ CSPR)

Run with `bun test`.

## What's in the repo

```
agentpay/
├── prisma/
│   └── schema.prisma              # 5-model schema (TreasuryConfig, TreasuryDecision, …)
├── src/
│   └── lib/
│       ├── casper/
│       │   ├── account-hash.ts    # blake2b account hash for ed25519 + secp256k1
│       │   ├── bincode.ts         # Rust bincode serializer (deploy body + header)
│       │   ├── deploy.ts          # Native transfer deploy builder + verifyDeployHash
│       │   ├── rpc.ts             # Casper JSON-RPC client
│       │   └── signing.ts         # Ed25519 + secp256k1 deploy signing
│       ├── treasury/
│       │   └── agent.ts           # The Treasury Agent (530 LOC)
│       ├── x402/
│       │   └── client.ts          # HTTP 402 client + payment proof encoding
│       ├── utils/
│       │   └── units.ts           # motes <-> CSPR conversion
│       ├── db.ts                  # Prisma client singleton
│       └── env.ts                 # Typed env loader
├── scripts/
│   ├── check-account.ts           # Verify funded account (hash + balance)
│   ├── demo-treasury.ts           # End-to-end demo (4 scenarios)
│   └── gen-arch-diagram.py        # Generate architecture PNG
├── tests/
│   └── core.test.ts               # 36 unit tests
├── package.json
├── tsconfig.json
└── .env.local
```

## Roadmap

| Status | Item |
|---|---|
| ✅ Done | Casper RPC integration (account info, balance, put_deploy) |
| ✅ Done | x402 protocol client (challenge parsing, payment proof encoding) |
| ✅ Done | Treasury Agent decision pipeline (policy + GLM-4.6 LLM review) |
| ✅ Done | Bincode serializer for native transfer deploys |
| ✅ Done | Audit log via Prisma/SQLite |
| ✅ Done | Unit tests for all deterministic primitives |
| ✅ Done | Live demo against funded testnet account (5000 CSPR) |
| 🔜 Next | Real on-chain payment submission (needs treasury private key) |
| 🔜 Next | Smart contract deployment for x402 service registry |
| 🔜 Next | Multi-treasury support (multiple agents sharing one treasury) |
| 🔜 Next | Replay-attack protection via nonce tracking |

## License

MIT — built for the Casper x Z.ai BUIDL hackathon.

## Links

- **Live demo account:** https://testnet.cspr.live/account/02028689d1185c208db3f891098bb83ab3ddd79ac6512289d25911df1ff912fcf0b9
- **x402 protocol spec:** https://github.com/walletconnect/x402
- **Casper docs:** https://docs.casper.network
- **GLM-4.6:** https://z.ai
