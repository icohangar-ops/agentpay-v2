import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

function hasLangfuseEnv() {
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY?.trim() && process.env.LANGFUSE_SECRET_KEY?.trim());
}

type LangfuseState = {
  spanProcessor: LangfuseSpanProcessor;
  tracerProvider: NodeTracerProvider;
};

const g = globalThis as typeof globalThis & {
  __agentPayLangfuse?: LangfuseState;
};

export function initLangfuseTracing(): LangfuseState {
  if (!hasLangfuseEnv()) {
    return null as unknown as LangfuseState;
  }

  if (g.__agentPayLangfuse) return g.__agentPayLangfuse;

  const spanProcessor = new LangfuseSpanProcessor({ exportMode: 'immediate' });
  const tracerProvider = new NodeTracerProvider({ spanProcessors: [spanProcessor] });
  tracerProvider.register();

  g.__agentPayLangfuse = { spanProcessor, tracerProvider };
  return g.__agentPayLangfuse;
}

export const langfuseSpanProcessor = {
  async forceFlush() {
    return undefined;
  },
};

initLangfuseTracing();
