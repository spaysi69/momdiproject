import client from 'prom-client';
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });
export const requests = new client.Counter({ name: 'enrichment_requests_total', help: 'Total enrichment requests', registers: [registry], labelNames: ['outcome'] });
export const providerCalls = new client.Counter({ name: 'provider_calls_total', help: 'Provider calls', registers: [registry], labelNames: ['route', 'outcome'] });
export const providerLatency = new client.Histogram({ name: 'provider_latency_seconds', help: 'Provider latency', registers: [registry], labelNames: ['route'], buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30] });
