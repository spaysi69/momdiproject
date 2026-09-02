"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRedis = createRedis;
const ioredis_1 = __importDefault(require("ioredis"));
function createRedis(url = process.env.REDIS_URL ?? 'redis://localhost:6379') {
    return new ioredis_1.default(url, { maxRetriesPerRequest: 2 });
}
