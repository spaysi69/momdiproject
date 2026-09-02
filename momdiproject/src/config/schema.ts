import { z } from 'zod';

const RouteSchema = z.object({
  id: z.string().min(1),
  apiKeyEnv: z.string().min(1),
  credits: z.number().int().nonnegative(),
  limits: z.object({
    rpm: z.number().int().positive(),
    rpd: z.number().int().positive(),
  }),
  priority: z.number().int().default(100),
  egressGroup: z.string().min(1).default('default'),
  proxyUrlEnv: z.string().min(1).optional(),
});

export const ServiceConfigSchema = z.object({
  service: z.literal('seamlessai'),
  providerBaseUrl: z.string().url().default('https://api.seamless.ai/api/client/v1'),
  apiKeyEnv: z.string().min(1).default('SEAMLESS_API_KEY_PRIMARY'),
  limits: z.object({ rpm: z.number().int().positive().default(60), rpd: z.number().int().positive().default(10000) }),
  credits: z.object({ starting: z.number().int().nonnegative().default(70) }).default({ starting: 70 }),
  routes: z.array(RouteSchema).min(1).optional(),
  maxAttempts: z.number().int().min(1).max(5).default(3),
  requestTimeoutMs: z.number().int().positive().default(30000),
  pollIntervalMs: z.number().int().positive().max(10000).default(2500),
  maxPolls: z.number().int().positive().max(240).default(120),
  cacheTtlSeconds: z.number().int().positive().default(86400),
});

export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
export type RouteConfig = z.infer<typeof RouteSchema>;
