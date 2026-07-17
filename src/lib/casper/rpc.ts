// Casper JSON-RPC client for the testnet.
//
// IMPORTANT: Balance queries MUST use `state_get_balance` with
// `purse_uref` + `state_root_hash`. The `query_global_state` method
// returns a Unit CLValue for purses, which makes balances read as 0.

import { env } from '../env';

interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface RpcResponse<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export interface CasperAccountInfo {
  account_hash: string;
  main_purse: string;
  named_keys: unknown[];
  associated_keys: { account_hash: string; weight: number }[];
  action_thresholds: { deployment: number; key_management: number };
}

let nextId = 1;

export class CasperRpc {
  constructor(private url: string = env.casper.rpcUrl) {}

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const body: RpcRequest = { jsonrpc: '2.0', id: nextId++, method, params };
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as RpcResponse<T>;
    if (json.error) throw new Error(`RPC ${method} error: ${json.error.message}`);
    if (!json.result) throw new Error(`RPC ${method}: empty result`);
    return json.result;
  }

  async getLatestBlock(): Promise<{ hash: string; height: number; stateRootHash: string }> {
    const r = await this.call<{
      block_with_signatures: {
        block: {
          Version2: {
            hash: string;
            header: { height: number; state_root_hash: string };
          };
        };
      };
    }>('chain_get_block', {});
    const b = r.block_with_signatures.block.Version2;
    return { hash: b.hash, height: b.header.height, stateRootHash: b.header.state_root_hash };
  }

  async getStateRootHash(): Promise<string> {
    // For Casper 2.0, chain_get_state_root_hash returns the LATEST block's srh,
    // but state_get_account_info requires a block_identifier. We get the latest block
    // and use its hash as the identifier.
    return (await this.getLatestBlock()).stateRootHash;
  }

  async getAccountInfo(publicKey: string): Promise<{ account: CasperAccountInfo; blockHash: string; stateRootHash: string }> {
    const block = await this.getLatestBlock();
    const r = await this.call<{ account: CasperAccountInfo }>('state_get_account_info', {
      public_key: publicKey,
      block_identifier: { Hash: block.hash },
    });
    return { account: r.account, blockHash: block.hash, stateRootHash: block.stateRootHash };
  }

  async getBalance(purseUref: string): Promise<{ motes: bigint; stateRootHash: string }> {
    // Casper 2.0: state_get_balance also requires block_identifier (not state_root_hash).
    // The response includes balance_value + merkle_proof, but NOT state_root_hash
    // (that was an input). We return the block's state_root_hash for the caller's info.
    const block = await this.getLatestBlock();
    const r = await this.call<{ balance_value: string; merkle_proof: string }>(
      'state_get_balance',
      { purse_uref: purseUref, state_root_hash: block.stateRootHash },
    );
    return { motes: BigInt(r.balance_value), stateRootHash: block.stateRootHash };
  }

  async putDeploy(deploy: unknown): Promise<{ deploy_hash: string }> {
    return this.call<{ deploy_hash: string }>('account_put_deploy', { deploy });
  }

  async getDeploy(deployHash: string) {
    return this.call<{ deploy: unknown; execution_results: unknown[] }>('info_get_deploy', {
      deploy_hash: deployHash,
    });
  }
}

export const rpc = new CasperRpc();
