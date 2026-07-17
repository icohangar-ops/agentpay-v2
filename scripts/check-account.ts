#!/usr/bin/env bun
// Verify the funded Treasury account on Casper testnet.
//
// Funded account (secp256k1, 5000 CSPR confirmed via faucet transfer):
//   PublicKey:    02028689d1185c208db3f891098bb83ab3ddd79ac6512289d25911df1ff912fcf0b9
//   AccountHash:  account-hash-4373087ef51351ba91c7642907eab2c2e9bfe7d460eb1b4c2fe7e1475fc78e04
//   Explorer:     https://testnet.cspr.live/account/02028689d1185c208db3f891098bb83ab3ddd79ac6512289d25911df1ff912fcf0b9

import { computeAccountHash } from '../src/lib/casper/account-hash';
import { rpc } from '../src/lib/casper/rpc';
import { motesToCspr } from '../src/lib/utils/units';

const PUB_KEY = '02028689d1185c208db3f891098bb83ab3ddd79ac6512289d25911df1ff912fcf0b9';
const EXPECTED_HASH = 'account-hash-4373087ef51351ba91c7642907eab2c2e9bfe7d460eb1b4c2fe7e1475fc78e04';

async function main() {
  console.log('Verifying funded Treasury account on Casper testnet...\n');

  // 1. Compute and verify the account hash locally
  const computedHash = computeAccountHash(PUB_KEY);
  console.log(`Public Key:   ${PUB_KEY}`);
  console.log(`Computed:     ${computedHash}`);
  console.log(`Expected:     ${EXPECTED_HASH}`);
  if (computedHash === EXPECTED_HASH) {
    console.log('Account hash matches.\n');
  } else {
    console.log('Account hash MISMATCH\n');
    process.exit(1);
  }

  // 2. Fetch on-chain account info via state_get_account_info
  console.log('Fetching account info from testnet RPC...');
  const { account, blockHash, stateRootHash } = await rpc.getAccountInfo(PUB_KEY);
  console.log(`Block Hash:      ${blockHash}`);
  console.log(`State Root Hash: ${stateRootHash}`);
  console.log(`Account Hash:    ${account.account_hash}`);
  console.log(`Main Purse:      ${account.main_purse}`);
  console.log(`Associated Keys: ${account.associated_keys.length}`);

  // 3. Fetch balance via state_get_balance (NOT query_global_state)
  console.log('\nFetching balance via state_get_balance...');
  const bal = await rpc.getBalance(account.main_purse);
  console.log(`State Root Hash: ${bal.stateRootHash}`);
  console.log(`Balance (motes): ${bal.motes.toString()}`);
  console.log(`Balance (CSPR):  ${motesToCspr(bal.motes).toFixed(4)}`);

  if (bal.motes > 0n) {
    console.log('\nTreasury is funded and ready.');
  } else {
    console.log('\nTreasury has 0 balance — faucet funding may be required.');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
