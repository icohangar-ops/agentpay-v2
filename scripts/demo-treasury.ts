#!/usr/bin/env bun
// AgentPay Treasury Agent — end-to-end demo.
//
// This script demonstrates the full x402 + Treasury Agent flow against
// the live Casper testnet:
//
//   1. Verify the funded treasury account (5000 CSPR)
//   2. Seed demo data (services, agents, treasury config)
//   3. Simulate an incoming x402 payment challenge
//   4. Let the Treasury Agent decide via policy + GLM-4.6
//   5. Print the structured decision + audit trail
//
// Usage:
//   bun run scripts/demo-treasury.ts

import { db } from '../src/lib/db';
import { startActiveObservation } from '@langfuse/tracing';
import { rpc } from '../src/lib/casper/rpc';
import { computeAccountHash } from '../src/lib/casper/account-hash';
import { motesToCspr, csprToMotes } from '../src/lib/utils/units';
import { TreasuryAgent } from '../src/lib/treasury/agent';
import { parseX402Challenge } from '../src/lib/x402/client';
import { env } from '../src/lib/env';
import { langfuseSpanProcessor } from '../src/lib/observability/langfuse';

const TREASURY_PUB = env.casper.treasuryPublicKey;

// ─── Demo data ────────────────────────────────────────────────────────────

const DEMO_SERVICES = [
  {
    serviceId: 'web-search-zai',
    name: 'ZAI Web Search API',
    baseUrl: 'https://api.z.ai/search',
    defaultPriceMotes: csprToMotes(0.05),
    trustScore: 85,
    policy: 'AUTO_APPROVE_UNDER',
  },
  {
    serviceId: 'llm-gpt4-research',
    name: 'GPT-4 Research Endpoint',
    baseUrl: 'https://research.example.com/v1/llm',
    defaultPriceMotes: csprToMotes(0.5),
    trustScore: 70,
    policy: 'LLM_REVIEW',
  },
  {
    serviceId: 'image-gen-flux',
    name: 'FLUX Image Generation',
    baseUrl: 'https://img.example.com/v1/generate',
    defaultPriceMotes: csprToMotes(0.2),
    trustScore: 60,
    policy: 'LLM_REVIEW',
  },
  {
    serviceId: 'shady-scraper',
    name: 'Unknown Scraper Service',
    baseUrl: 'https://sketchy.example.com/scrape',
    defaultPriceMotes: csprToMotes(0.1),
    trustScore: 25,
    policy: 'LLM_REVIEW',
  },
  {
    serviceId: 'blocked-malware-feed',
    name: 'Known Malware C2 Endpoint',
    baseUrl: 'https://malicious.example.com/feed',
    defaultPriceMotes: csprToMotes(0.01),
    trustScore: 5,
    policy: 'BLOCKED',
  },
];

const DEMO_AGENTS = [
  {
    agentId: 'research-agent-01',
    name: 'Research Agent (GLM-4.6)',
    description: 'Long-horizon web research agent. Calls search APIs and LLMs.',
    maxPerPaymentCspr: 1.0,
    hourlyBudgetCspr: 5.0,
    dailyBudgetCspr: 50.0,
  },
  {
    agentId: 'image-bot-02',
    name: 'Image Bot',
    description: 'Generates images from text prompts for users.',
    maxPerPaymentCspr: 0.5,
    hourlyBudgetCspr: 2.0,
    dailyBudgetCspr: 20.0,
  },
];

// Simulated x402 challenges for the demo. Each one represents a different
// scenario the Treasury Agent should handle differently.
const DEMO_SCENARIOS = [
  {
    label: 'Small payment to a high-trust service (should auto-approve)',
    agentId: 'research-agent-01',
    serviceId: 'web-search-zai',
    requestUrl: 'https://api.z.ai/search?q=casper+blockchain',
    taskContext: 'Searching for latest Casper blockchain news for a user query.',
    wwwAuth: `x402 requirements="${Buffer.from(JSON.stringify({
      network: 'casper-test',
      asset: 'cspr',
      amount: csprToMotes(0.05).toString(),
      to: 'account-hash-4373087ef51351ba91c7642907eab2c2e9bfe7d460eb1b4c2fe7e1475fc78e04',
      description: 'Single web search query',
      nonce: 'demo-nonce-1',
    })).toString('base64url')}"`,
  },
  {
    label: 'Medium payment to a review-required service (LLM decides)',
    agentId: 'research-agent-01',
    serviceId: 'llm-gpt4-research',
    requestUrl: 'https://research.example.com/v1/llm/complete',
    taskContext: 'User asked for an in-depth analysis of Casper\'s consensus mechanism. This LLM call is the core of the response.',
    wwwAuth: `x402 requirements="${Buffer.from(JSON.stringify({
      network: 'casper-test',
      asset: 'cspr',
      amount: csprToMotes(0.5).toString(),
      to: 'account-hash-4373087ef51351ba91c7642907eab2c2e9bfe7d460eb1b4c2fe7e1475fc78e04',
      description: 'GPT-4 completion request (1k tokens)',
      nonce: 'demo-nonce-2',
    })).toString('base64url')}"`,
  },
  {
    label: 'Payment to a low-trust service (LLM should be skeptical)',
    agentId: 'image-bot-02',
    serviceId: 'shady-scraper',
    requestUrl: 'https://sketchy.example.com/scrape?url=example.com',
    taskContext: 'Trying to scrape a webpage for image URLs. No critical user value.',
    wwwAuth: `x402 requirements="${Buffer.from(JSON.stringify({
      network: 'casper-test',
      asset: 'cspr',
      amount: csprToMotes(0.1).toString(),
      to: 'account-hash-4373087ef51351ba91c7642907eab2c2e9bfe7d460eb1b4c2fe7e1475fc78e04',
      description: 'Generic scraper call',
      nonce: 'demo-nonce-3',
    })).toString('base64url')}"`,
  },
  {
    label: 'Payment to a blocked service (should auto-deny)',
    agentId: 'research-agent-01',
    serviceId: 'blocked-malware-feed',
    requestUrl: 'https://malicious.example.com/feed',
    taskContext: 'Trying to fetch a feed (this service is on the block list).',
    wwwAuth: `x402 requirements="${Buffer.from(JSON.stringify({
      network: 'casper-test',
      asset: 'cspr',
      amount: csprToMotes(0.01).toString(),
      to: 'account-hash-4373087ef51351ba91c7642907eab2c2e9bfe7d460eb1b4c2fe7e1475fc78e04',
      description: 'Feed fetch',
      nonce: 'demo-nonce-4',
    })).toString('base64url')}"`,
  },
];

// ─── Demo runner ──────────────────────────────────────────────────────────

async function seedDemoData() {
  console.log('Seeding demo data...');

  // Upsert treasury config
  const accountHash = computeAccountHash(TREASURY_PUB);
  await db.treasuryConfig.upsert({
    where: { agentId: 'research-agent-01' },
    create: {
      agentId: 'research-agent-01',
      treasuryName: 'AgentPay Demo Treasury',
      algorithm: 'secp256k1',
      publicKey: TREASURY_PUB,
      accountHash,
      maxPerPaymentCspr: 1.0,
      hourlyBudgetCspr: 5.0,
      dailyBudgetCspr: 50.0,
    },
    update: {
      publicKey: TREASURY_PUB,
      accountHash,
    },
  });

  // Upsert services
  for (const svc of DEMO_SERVICES) {
    await db.x402Service.upsert({
      where: { serviceId: svc.serviceId },
      create: svc,
      update: {
        name: svc.name,
        baseUrl: svc.baseUrl,
        defaultPriceMotes: svc.defaultPriceMotes,
        trustScore: svc.trustScore,
        policy: svc.policy,
      },
    });
  }

  // Upsert agents
  for (const ag of DEMO_AGENTS) {
    await db.agentIdentity.upsert({
      where: { agentId: ag.agentId },
      create: ag,
      update: {
        name: ag.name,
        description: ag.description,
        maxPerPaymentCspr: ag.maxPerPaymentCspr,
        hourlyBudgetCspr: ag.hourlyBudgetCspr,
        dailyBudgetCspr: ag.dailyBudgetCspr,
      },
    });
  }

  console.log(`  ${DEMO_SERVICES.length} services, ${DEMO_AGENTS.length} agents, 1 treasury config.`);
}

async function printTreasuryStatus() {
  console.log('\nTREASURY STATUS');
  console.log('===============');
  console.log(`Public Key:    ${TREASURY_PUB}`);
  const { account } = await rpc.getAccountInfo(TREASURY_PUB);
  console.log(`Account Hash:  ${account.account_hash}`);
  console.log(`Main Purse:    ${account.main_purse}`);
  const bal = await rpc.getBalance(account.main_purse);
  console.log(`Balance:       ${motesToCspr(bal.motes).toFixed(4)} CSPR (${bal.motes.toString()} motes)`);
  console.log(`State root:    ${bal.stateRootHash.slice(0, 16)}...`);
}

async function runScenario(scenario: typeof DEMO_SCENARIOS[number], agent: TreasuryAgent) {
  await startActiveObservation('demo-treasury-scenario', async (span) => {
    span.update({ input: { label: scenario.label, agentId: scenario.agentId, serviceId: scenario.serviceId } });

    console.log('\n──────────────────────────────────────────────────────────────────');
    console.log(`SCENARIO: ${scenario.label}`);
    console.log('──────────────────────────────────────────────────────────────────');

    const challenge = parseX402Challenge(scenario.wwwAuth);
    console.log(`Service:    ${challenge.requirements.description ?? '(no description)'}`);
    console.log(`Amount:     ${motesToCspr(BigInt(challenge.requirements.amount)).toFixed(6)} CSPR`);
    console.log(`Recipient:  ${challenge.requirements.to}`);

    const req = {
      agentId: scenario.agentId,
      serviceId: scenario.serviceId,
      serviceName: challenge.requirements.description ?? scenario.serviceId,
      requestUrl: scenario.requestUrl,
      challenge,
      taskContext: scenario.taskContext,
    };

    console.log('\nCalling Treasury Agent.evaluate()...');
    const t0 = Date.now();
    const decision = await agent.evaluate(req);
    const dt = Date.now() - t0;

    console.log(`\nDECISION (${dt}ms)`);
    console.log('==========');
    console.log(`Verdict:           ${decision.verdict}`);
    console.log(`Source:            ${decision.source}`);
    console.log(`Approved amount:   ${motesToCspr(decision.approvedAmountMotes).toFixed(6)} CSPR`);
    if (decision.counterAmountMotes) {
      console.log(`Counter amount:    ${motesToCspr(decision.counterAmountMotes).toFixed(6)} CSPR`);
    }
    console.log(`Rationale:         ${decision.rationale}`);
    if (decision.nextStep) console.log(`Next step:         ${decision.nextStep}`);
    if (decision.llmResponse) {
      console.log(`\nLLM raw response:`);
      console.log(decision.llmResponse);
    }

    // If approved, attempt to construct (and dry-run-execute) the deploy.
    // This exercises the full bincode serialization + deploy_hash computation.
    if (decision.verdict === 'APPROVE') {
      console.log('\nCONSTRUCTING ON-CHAIN PAYMENT DEPLOY');
      console.log('=====================================');
      const exec = await agent.executePayment(req, decision);
      if ('error' in exec) {
        console.log(`Error: ${exec.error}`);
      } else if (exec.mode === 'DRY_RUN') {
        console.log(`Mode:           DRY_RUN (no private key — not submitted)`);
        console.log(`Deploy hash:    ${exec.deployHash}`);
        console.log(`Body hash:      ${exec.deploy.header.body_hash}`);
        console.log(`From (pubkey):  ${exec.deploy.header.account.slice(0, 16)}...`);
        console.log(`Source purse:   ${exec.deploy.session.Transfer.args[1][1].parsed}`);
        console.log(`Target purse:   ${exec.deploy.session.Transfer.args[2][1].parsed}`);
        console.log(`Amount:         ${motesToCspr(BigInt(exec.deploy.session.Transfer.args[0][1].parsed)).toFixed(6)} CSPR`);
        console.log(`Chain:          ${exec.deploy.header.chain_name}`);
        console.log(`TTL:            ${exec.deploy.header.ttl}`);
        console.log(`Timestamp:      ${exec.deploy.header.timestamp}`);
        console.log(`Approvals:      ${exec.deploy.approvals.length} (unsigned)`);
        console.log(`\nNote:           ${exec.note}`);
        console.log(`\nX402 PAYMENT PROOF:`);
        console.log(JSON.stringify(exec.proof, null, 2));
      } else if (exec.mode === 'SUBMITTED') {
        console.log(`Mode:           SUBMITTED`);
        console.log(`Deploy hash:    ${exec.deployHash}`);
        console.log(`Explorer:       https://testnet.cspr.live/deploy/${exec.deployHash}`);
        if (exec.executionResult) {
          console.log(`Execution:      ${JSON.stringify(exec.executionResult).slice(0, 200)}...`);
        }
        console.log(`\nX402 PAYMENT PROOF:`);
        console.log(JSON.stringify(exec.proof, null, 2));
      }
    }

    span.update({ output: { verdict: decision.verdict, source: decision.source } });
  });
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  AgentPay v2 — Live Demo                                          ║');
  console.log('║  x402 protocol + Casper testnet + GLM-4.6 decision engine         ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');

  await seedDemoData();
  await printTreasuryStatus();

  const agent = new TreasuryAgent(TREASURY_PUB);
  // Note: no private key set, so we're in decision-only mode.
  // executePayment() would return an error if called.

  for (const scenario of DEMO_SCENARIOS) {
    await runScenario(scenario, agent);
  }

  // Print final audit log
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('AUDIT LOG (all decisions this session, persisted to SQLite)');
  console.log('══════════════════════════════════════════════════════════════════');
  const decisions = await db.treasuryDecision.findMany({
    orderBy: { createdAt: 'asc' },
  });
  for (const d of decisions) {
    console.log(`  [${d.createdAt.toISOString()}] ${d.decision.padEnd(8)} ${d.decisionSource.padEnd(22)} ${d.serviceName.padEnd(40)} ${motesToCspr(d.amountRequiredMotes).toFixed(4)} CSPR`);
  }

  await db.$disconnect();
  await langfuseSpanProcessor.forceFlush();
  console.log('\nDemo complete.');
}

main().catch(async err => {
  console.error('Demo failed:', err);
  await db.$disconnect();
  process.exit(1);
});
