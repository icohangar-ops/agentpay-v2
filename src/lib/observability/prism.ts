import { randomUUID } from 'node:crypto';

const DEFAULT_PRISM_HOST = 'https://api.prism.blockconvey.com';

type PrismTraceInput = {
  traceId?: string;
  agentId: string;
  agentName: string;
  model: string;
  inputMessages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>;
  output: string;
  latencyMs: number;
  tokenCountInput?: number;
  tokenCountOutput?: number;
  metadata?: Record<string, unknown>;
};

function getEnv(name: string): string {
  return (process.env[name] || '').trim();
}

function resolveHost(): string {
  return getEnv('PRISMTRACE_HOST') || getEnv('PRISMTRACE_ENDPOINT') || DEFAULT_PRISM_HOST;
}

export async function tracePrismLLM(input: PrismTraceInput): Promise<void> {
  const apiKey = getEnv('PRISMTRACE_API_KEY');
  const projectId = getEnv('PRISMTRACE_PROJECT_ID');
  if (!apiKey || !projectId) return;

  const traceId = input.traceId || randomUUID();
  const host = resolveHost();
  await fetch(new URL('/api/traces', host), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PRISMtrace-Key': apiKey,
    },
    body: JSON.stringify({
      project_id: projectId,
      model: input.model,
      input_messages: input.inputMessages,
      output_message: input.output,
      latency_ms: input.latencyMs,
      token_count_input: input.tokenCountInput ?? 0,
      token_count_output: input.tokenCountOutput ?? 0,
      trace_id: traceId,
      agent_id: input.agentId,
      agent_name: input.agentName,
      metadata: input.metadata,
    }),
  });
}
