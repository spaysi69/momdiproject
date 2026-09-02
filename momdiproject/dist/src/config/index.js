"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const schema_1 = require("./schema");
function loadConfig(configPath = node_path_1.default.join(process.cwd(), 'config.json')) {
    if (!node_fs_1.default.existsSync(configPath))
        throw new Error(`Config file not found: ${configPath}`);
    const raw = JSON.parse(node_fs_1.default.readFileSync(configPath, 'utf8'));
    const withOverrides = {
        ...raw,
        providerBaseUrl: process.env.PROVIDER_BASE_URL?.trim() || raw.providerBaseUrl,
    };
    const parsed = schema_1.ServiceConfigSchema.safeParse(withOverrides);
    if (!parsed.success)
        throw new Error(`Invalid config: ${parsed.error.message}`);
    return parsed.data;
}
