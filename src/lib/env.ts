// AgentPay environment loader.
// Bun automatically loads .env.local, but we provide a manual fallback
// for environments where auto-loading doesn't apply (e.g., plain node).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function loadEnvFile() {
  // .env.local should override the parent .env, so we always load it
  // and let local values win.
  const envPath = join(import.meta.dir, '..', '..', '.env.local');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;  // .env.local wins over inherited env
  }
}

loadEnvFile();

export const env = {
  casper: {
    rpcUrl: process.env.CASPER_RPC_URL || 'https://node.testnet.casper.network/rpc',
    chainName: process.env.CASPER_CHAIN_NAME || 'casper-test',
    treasuryPublicKey: process.env.CASPER_TREASURY_PUBLIC_KEY || '',
    treasuryPrivateKey: process.env.CASPER_TREASURY_PRIVATE_KEY || '',
  },
  db: { url: process.env.DATABASE_URL || 'file:./db/dev.db' },
  x402: {
    facilitatorPort: parseInt(process.env.X402_FACILITATOR_PORT || '8080', 10),
    defaultMaxAmountCspr: parseFloat(process.env.X402_DEFAULT_MAX_AMOUNT_CSPR || '10'),
    defaultBudgetCsprPerHour: parseFloat(process.env.X402_DEFAULT_BUDGET_CSPR_PER_HOUR || '50'),
  },
  glm: { model: process.env.GLM_MODEL || 'glm-4.6' },
} as const;

export type Env = typeof env;
