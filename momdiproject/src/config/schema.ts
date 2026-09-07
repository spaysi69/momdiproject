import { z } from 'zod';

export const ServiceConfigSchema = z.object({
  service: z.literal('seamlessai'),
  mcpBaseUrl: z.string().url().default('https://mcp.seamless.ai/mcp'),
  requestTimeoutMs: z.number().int().positive().default(30000),
  pollIntervalMs: z.number().int().positive().max(10000).default(2000),
  maxPolls: z.number().int().positive().max(120).default(30),
  cacheTtlSeconds: z.number().int().positive().default(86400),
});
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
