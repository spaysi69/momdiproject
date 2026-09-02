import { z } from 'zod';

const IpSchema = z.string().ip().optional();

export const RouteConfigSchema = z.object({
  id: z.string().min(1),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  limits: z.object({ rpm: z.number().int().positive(), rpd: z.number().int().positive() }),
  priority: z.number().int().nonnegative().default(0),
  enabled: z.boolean().default(true),
  expectedEgressIp: IpSchema,
  networkLabel: z.string().min(1).optional(),
});

export const RouteOverrideSchema = RouteConfigSchema.partial().extend({
  id: z.string().min(1),
  limits: z.object({ rpm: z.number().int().positive(), rpd: z.number().int().positive() }).optional(),
});

export const AppConfigSchema = z.object({
  service: z.literal('seamlessai'),
  credentialDiscovery: z.object({
    envPrefix: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default('SEAMLESS_API_KEY_'),
    numericSuffixOnly: z.boolean().default(true),
    defaultLimits: z.object({ rpm: z.number().int().positive(), rpd: z.number().int().positive() }).default({ rpm: 60, rpd: 10000 }),
    defaultPriority: z.number().int().nonnegative().default(0),
    defaultEnabled: z.boolean().default(true),
  }).default({
    envPrefix: 'SEAMLESS_API_KEY_',
    numericSuffixOnly: true,
    defaultLimits: { rpm: 60, rpd: 10000 },
    defaultPriority: 0,
    defaultEnabled: true,
  }),
  network: z.object({
    egressIpCheckUrl: z.string().url().default('https://api.ipify.org?format=json'),
    egressIpCheckTimeoutMs: z.number().int().positive().max(10_000).default(2_500),
  }).default({
    egressIpCheckUrl: 'https://api.ipify.org?format=json',
    egressIpCheckTimeoutMs: 2_500,
  }),
  queue: z.object({
    enabled: z.boolean().default(true),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    jobTimeoutMs: z.number().int().positive().max(120_000).default(30_000),
  }),
  cache: z.object({
    enabled: z.boolean().default(true),
    ttlSeconds: z.number().int().positive().max(7 * 86400).default(86400),
  }),
  routes: z.array(RouteOverrideSchema).default([]),
});

export type RouteConfig = z.infer<typeof RouteConfigSchema>;
export type RouteOverride = z.infer<typeof RouteOverrideSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
