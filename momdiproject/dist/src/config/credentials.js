"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.seamlessCredential = seamlessCredential;
function seamlessCredential(env = process.env) {
    const allowed = ['SEAMLESS_MCP_API_KEY', 'SEAMLESS_API_KEY_PRIMARY', 'SEAMLESS_API_KEY_SECONDARY', 'SEAMLESS_API_KEY_3', 'SEAMLESS_API_KEY_4', 'SEAMLESS_API_KEY_5'];
    const selected = env.SEAMLESS_MCP_KEY_SOURCE?.trim();
    if (selected && !allowed.includes(selected))
        throw new Error('SEAMLESS_MCP_KEY_SOURCE must name a supported Seamless key environment variable.');
    const source = selected || allowed.find(name => env[name]?.trim());
    if (!source || !env[source]?.trim())
        throw new Error('Configure a Seamless MCP-enabled API key in Render.');
    return { source, key: env[source].trim() };
}
