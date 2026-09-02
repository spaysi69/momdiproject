import { z } from 'zod';

export const ServiceConfigSchema = z.object({
  service: z.literal('seamlessai'),
  providerBaseUrl: z.string().url(),
  providerPath: z.string().min(1),
  apiKeyEnv: z.string().min(1),
  limits: z.object({
    rpm: z.number().int().positive(),
    rpd: z.number().int().positive(),
  }),
  maxAttempts: z.number().int().min(1).max(5).default(3),
  requestTimeoutMs: z.number().int().positive().default(30000),
  cacheTtlSeconds: z.number().int().positive().default(86400),
});

export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
