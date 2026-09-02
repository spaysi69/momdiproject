"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServiceConfigSchema = void 0;
const zod_1 = require("zod");
exports.ServiceConfigSchema = zod_1.z.object({
    service: zod_1.z.literal('seamlessai'),
    providerBaseUrl: zod_1.z.string().url().default('https://api.seamless.ai/api/client/v1'),
    apiKeyEnv: zod_1.z.string().min(1).default('SEAMLESS_API_KEY_PRIMARY'),
    limits: zod_1.z.object({
        rpm: zod_1.z.number().int().positive().default(60),
        rpd: zod_1.z.number().int().positive().default(10000),
    }),
    credits: zod_1.z.object({
        starting: zod_1.z.number().int().nonnegative().default(70),
    }).default({ starting: 70 }),
    maxAttempts: zod_1.z.number().int().min(1).max(5).default(3),
    requestTimeoutMs: zod_1.z.number().int().positive().default(30000),
    pollIntervalMs: zod_1.z.number().int().positive().max(10000).default(2500),
    maxPolls: zod_1.z.number().int().positive().max(120).default(36),
    cacheTtlSeconds: zod_1.z.number().int().positive().default(86400),
});
