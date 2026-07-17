// x402 protocol — HTTP 402 payment client.
//
// The x402 protocol lets AI agents pay for API calls by handling HTTP 402
// (Payment Required) responses. The flow is:
//
//   1. Agent makes a normal HTTP request to a service
//   2. Service responds with 402 + WWW-Authenticate header describing the
//      payment requirements (network, asset, amount, recipient, etc.)
//   3. Agent constructs a payment (e.g. a Casper transfer to the recipient)
//   4. Agent retries the request with the payment proof in the
//      X-PAYMENT header
//   5. Service verifies the payment and returns the requested content
//
// This module handles steps 1, 2, and 4. Step 3 (the actual payment) is
// handled by the treasury agent.

export interface X402PaymentRequirements {
  /** Scheme version (usually "v1") */
  version?: string;
  /** Kind of payment: "exact" or "max" */
  kind?: string;
  /** Network identifier, e.g. "casper-test", "base-sepolia" */
  network: string;
  /** Asset identifier, e.g. "cspr", "usdc" */
  asset: string;
  /** Amount in the asset's smallest unit (motes for CSPR) */
  amount: string;
  /** Recipient address (Casper account hash or public key) */
  to: string;
  /** Description of what's being purchased */
  description?: string;
  /** Maximum time the payment is valid (seconds) */
  max_fee?: string;
  /** Resource being accessed */
  resource?: string;
  /** Service-chosen nonce for replay protection */
  nonce?: string;
}

export interface X402Challenge {
  /** Raw WWW-Authenticate header value */
  raw: string;
  /** Parsed requirements */
  requirements: X402PaymentRequirements;
  /** WWW-Authenticate scheme, e.g. "x402" */
  scheme: string;
}

/**
 * Parse a WWW-Authenticate header into an x402 challenge.
 *
 * The header format is:
 *   x402 requirements="<base64url-encoded-json>"
 * or:
 *   x402 network="casper-test",asset="cspr",amount="1000000000",to="..."
 */
export function parseX402Challenge(wwwAuth: string): X402Challenge {
  const trimmed = wwwAuth.trim();

  // Extract scheme (everything before the first space or =)
  const schemeMatch = trimmed.match(/^(\w+)\s+(.*)$/);
  if (!schemeMatch) {
    // Single-word scheme, no params
    return {
      raw: trimmed,
      scheme: trimmed,
      requirements: parseRequirementsFromParams(trimmed),
    };
  }

  const scheme = schemeMatch[1];
  const rest = schemeMatch[2];

  // Try base64url-encoded "requirements" param first
  const reqMatch = rest.match(/requirements="([^"]+)"/);
  if (reqMatch) {
    try {
      const b64 = reqMatch[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      const json = Buffer.from(padded, 'base64').toString('utf-8');
      const requirements = JSON.parse(json) as X402PaymentRequirements;
      return { raw: trimmed, scheme, requirements };
    } catch (e) {
      throw new Error(`Failed to decode x402 requirements: ${(e as Error).message}`);
    }
  }

  // Fall back to parsing individual params
  return {
    raw: trimmed,
    scheme,
    requirements: parseRequirementsFromParams(rest),
  };
}

function parseRequirementsFromParams(params: string): X402PaymentRequirements {
  const out: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(params)) !== null) {
    out[m[1]] = m[2];
  }
  return out as unknown as X402PaymentRequirements;
}

export interface X402PaymentProof {
  /** Network that was paid (e.g. "casper-test") */
  network: string;
  /** Deploy hash of the on-chain payment */
  deploy_hash: string;
  /** Sender public key */
  from: string;
  /** Recipient address */
  to: string;
  /** Amount paid in smallest unit */
  amount: string;
  /** Asset identifier */
  asset: string;
  /** Timestamp (ISO 8601) */
  timestamp: string;
}

/**
 * Encode a payment proof as the X-PAYMENT header value.
 * Uses base64url-encoded JSON.
 */
export function encodePaymentProof(proof: X402PaymentProof): string {
  const json = JSON.stringify(proof);
  return Buffer.from(json, 'utf-8').toString('base64url');
}

/**
 * Result of an x402-facilitated HTTP request.
 */
export interface X402FetchResult<T = unknown> {
  /** Final HTTP status (200 if successful, 402 if payment declined, etc.) */
  status: number;
  /** Response body (parsed if JSON) */
  body: T | string | null;
  /** The x402 challenge if status was 402, else null */
  challenge: X402Challenge | null;
  /** The payment proof if a payment was sent, else null */
  proof: X402PaymentProof | null;
  /** Response headers */
  headers: Record<string, string>;
}

/**
 * Make an x402-aware HTTP request. If the server responds with 402, return
 * the parsed challenge for the treasury agent to act on. The caller is
 * responsible for retrying with `retryWithPayment` after obtaining a proof.
 */
export async function x402Fetch(
  url: string,
  init: RequestInit = {},
): Promise<X402FetchResult> {
  const res = await fetch(url, init);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

  if (res.status === 402) {
    const wwwAuth = headers['www-authenticate'];
    if (!wwwAuth) {
      return {
        status: 402,
        body: await safeReadBody(res),
        challenge: null,
        proof: null,
        headers,
      };
    }
    return {
      status: 402,
      body: await safeReadBody(res),
      challenge: parseX402Challenge(wwwAuth),
      proof: null,
      headers,
    };
  }

  return {
    status: res.status,
    body: await safeReadBody(res),
    challenge: null,
    proof: null,
    headers,
  };
}

/**
 * Retry the original request with a payment proof in the X-PAYMENT header.
 */
export async function retryWithPayment(
  url: string,
  proof: X402PaymentProof,
  init: RequestInit = {},
): Promise<X402FetchResult> {
  const newHeaders = new Headers(init.headers);
  newHeaders.set('X-PAYMENT', encodePaymentProof(proof));
  return x402Fetch(url, { ...init, headers: newHeaders });
}

async function safeReadBody(res: Response): Promise<unknown> {
  const text = await res.text();
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text || null;
}
