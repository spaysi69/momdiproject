import { z } from 'zod';

export const ServiceConfigSchema = z.object({
  service: z.literal('seamlessai'),
  providerBaseUrl: z.string().url().default('https://api.seamless.ai/api/client/v1'),
  apiKeyEnv: z.string().min(1).default('SEAMLESS_API_KEY_PRIMARY'),
  limits: z.object({
    rpm: z.number().int().positive().default(60),
    rpd: z.number().int().positive().default(10000),
  }),
  maxAttempts: z.number().int().min(1).max(5).default(3),
  requestTimeoutMs: z.number().int().positive().default(30000),
  pollIntervalMs: z.number().int().positive().max(10000).default(2500),
  maxPolls: z.number().int().positive().max(120).default(36),
  cacheTtlSeconds: z.number().int().positive().default(86400),
});

export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
