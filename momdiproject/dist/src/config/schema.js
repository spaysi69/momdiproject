"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServiceConfigSchema = void 0;
const zod_1 = require("zod");
exports.ServiceConfigSchema = zod_1.z.object({
    service: zod_1.z.literal('seamlessai'),
    mcpBaseUrl: zod_1.z.string().url().default('https://mcp.seamless.ai/mcp'),
    requestTimeoutMs: zod_1.z.number().int().positive().default(30000),
    pollIntervalMs: zod_1.z.number().int().positive().max(10000).default(2000),
    maxPolls: zod_1.z.number().int().positive().max(120).default(30),
    cacheTtlSeconds: zod_1.z.number().int().positive().default(86400),
});
