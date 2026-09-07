"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnrichmentCache = void 0;
const zod_1 = require("zod");
const CacheSchema = zod_1.z.object({
    id: zod_1.z.string().optional(),
    fullName: zod_1.z.string().optional(),
    firstName: zod_1.z.string().optional(),
    lastName: zod_1.z.string().optional(),
    title: zod_1.z.string().optional(),
    company: zod_1.z.string().optional(),
    email: zod_1.z.string().optional(),
    phone: zod_1.z.string().optional(),
    linkedinUrl: zod_1.z.string().url(),
    department: zod_1.z.string().optional(),
    seniority: zod_1.z.string().optional(),
    alternateEmails: zod_1.z.array(zod_1.z.string()).optional(),
    alternatePhones: zod_1.z.array(zod_1.z.string()).optional(),
    companyDomain: zod_1.z.string().optional(),
    companyLinkedInUrl: zod_1.z.string().optional(),
    contactLocation: zod_1.z.record(zod_1.z.string(), zod_1.z.any()).optional(),
    companyLocation: zod_1.z.record(zod_1.z.string(), zod_1.z.any()).optional(),
    raw: zod_1.z.record(zod_1.z.string(), zod_1.z.any()).optional(),
});
class EnrichmentCache {
    redis;
    ttlSeconds;
    constructor(redis, ttlSeconds) {
        this.redis = redis;
        this.ttlSeconds = ttlSeconds;
    }
    async get(key) {
        const value = await this.redis.get(key);
        if (!value)
            return null;
        try {
            return CacheSchema.parse(JSON.parse(value));
        }
        catch {
            await this.redis.del(key);
            return null;
        }
    }
    async set(key, value) {
        await this.redis.set(key, JSON.stringify(value), 'EX', this.ttlSeconds);
    }
}
exports.EnrichmentCache = EnrichmentCache;
