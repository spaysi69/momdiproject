"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SeamlessMcpClient = exports.SeamlessMcpError = void 0;
exports.readRpcResponse = readRpcResponse;
const node_crypto_1 = __importDefault(require("node:crypto"));
const logger_1 = require("../utils/logger");
class SeamlessMcpError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'SeamlessMcpError';
    }
}
exports.SeamlessMcpError = SeamlessMcpError;
function parseJsonText(value) {
    const text = value.trim();
    if (!text)
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch { }
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fence) {
        try {
            return JSON.parse(fence[1]);
        }
        catch { }
    }
    const first = Math.min(...[text.indexOf('{'), text.indexOf('[')].filter(i => i >= 0));
    if (Number.isFinite(first)) {
        const candidate = text.slice(first);
        try {
            return JSON.parse(candidate);
        }
        catch { }
    }
    return undefined;
}
async function readRpcResponse(response, id) {
    if (!response.ok) {
        let reason = '';
        try {
            if (response.headers.get('content-type')?.includes('application/json')) {
                const body = await response.json();
                // Classify only known reasons; never echo an arbitrary provider body or a credential.
                const message = String(body?.error?.message || body?.message || body?.error || '').toLowerCase();
                if (/scope/.test(message))
                    reason = 'The selected API-key connection is missing the MCP scope.';
                else if (/not enabled|disabled/.test(message))
                    reason = 'MCP access is not enabled for this connection or account.';
                else if (/license|permission|access denied/.test(message))
                    reason = 'Seamless denied this connection access. Check its assigned group and account permissions.';
            }
        }
        catch { }
        const message = response.status === 403
            ? `Seamless refused access (403). ${reason || 'The exact reason was not supplied. Check the selected API key, MCP scope, and account access; contact Seamless support if these are already enabled.'} This is separate from your workspace password.`
            : response.status === 401 ? 'Seamless rejected the API key (401). Check the selected server key.'
                : response.status === 429 ? 'Seamless rate limit reached (429). Wait before trying again.'
                    : `Seamless MCP HTTP ${response.status}`;
        throw new SeamlessMcpError(`HTTP_${response.status}`, message);
    }
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
        const reader = response.body?.getReader();
        if (!reader)
            throw new SeamlessMcpError('INVALID_RESPONSE', 'Empty MCP stream');
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            while (true) {
                const { value, done } = await reader.read();
                buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
                let end;
                while ((end = buffer.indexOf('\n\n')) >= 0) {
                    const event = buffer.slice(0, end);
                    buffer = buffer.slice(end + 2);
                    const data = event.split('\n').filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
                    if (!data)
                        continue;
                    const message = JSON.parse(data);
                    if (message.id === id)
                        return message;
                }
                if (buffer.length > 5000000)
                    throw new SeamlessMcpError('INVALID_RESPONSE', 'MCP response too large');
                if (done)
                    break;
            }
            throw new SeamlessMcpError('INVALID_RESPONSE', 'MCP stream ended before the response');
        }
        finally {
            await reader.cancel().catch(() => { });
        }
    }
    const body = await response.json();
    if (body.id !== id)
        throw new SeamlessMcpError('INVALID_RESPONSE', 'MCP response ID mismatch');
    return body;
}
class SeamlessMcpClient {
    apiKey;
    baseUrl;
    timeoutMs;
    get credentialId() { return node_crypto_1.default.createHash('sha256').update(this.apiKey).digest('hex'); }
    constructor(apiKey, baseUrl = process.env.SEAMLESS_MCP_BASE_URL?.trim() || 'https://mcp.seamless.ai/mcp', timeoutMs = Number(process.env.SEAMLESS_MCP_TIMEOUT_MS || 30000)) {
        this.apiKey = apiKey;
        this.baseUrl = baseUrl;
        this.timeoutMs = timeoutMs;
        if (!apiKey)
            throw new Error('Missing required Seamless MCP API key');
    }
    toolListCache = null;
    async callTool(name, args = {}) {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await fetch(this.baseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Token: this.apiKey },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id }),
                signal: controller.signal,
            });
            const body = await readRpcResponse(response, id);
            if (body?.error) {
                throw new SeamlessMcpError(String(body.error.code ?? 'MCP_ERROR'), String(body.error.message ?? 'Seamless MCP request failed'), body.error.data);
            }
            return this.unwrapResult(body?.result);
        }
        catch (error) {
            if (error?.name === 'AbortError')
                throw new SeamlessMcpError('TIMEOUT', `Seamless MCP request timed out after ${this.timeoutMs}ms`);
            logger_1.logger.warn('seamless.mcp.call_failed', { tool: name, message: error?.message || String(error) });
            throw error;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    unwrapResult(result) {
        if (!result)
            return result;
        if (result.isError) {
            const message = Array.isArray(result.content) ? result.content.map((x) => x?.text).filter(Boolean).join('\n') : 'Seamless MCP tool returned an error';
            throw new SeamlessMcpError('TOOL_ERROR', message || 'Seamless MCP tool returned an error');
        }
        return result;
    }
    async listTools() {
        if (this.toolListCache && this.toolListCache.expiresAt > Date.now())
            return this.toolListCache.tools;
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await fetch(this.baseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Token: this.apiKey },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', params: {}, id }),
                signal: controller.signal,
            });
            const body = await readRpcResponse(response, id);
            if (body?.error)
                throw new SeamlessMcpError(String(body.error.code ?? 'MCP_ERROR'), String(body.error.message ?? 'Seamless MCP tools/list failed'), body.error.data);
            if (!Array.isArray(body?.result?.tools))
                throw new SeamlessMcpError('INVALID_TOOLS_LIST', 'Seamless MCP tools/list returned no tool list');
            const tools = Array.isArray(body?.result?.tools) ? body.result.tools : [];
            this.toolListCache = { expiresAt: Date.now() + 300000, tools };
            return tools;
        }
        catch (error) {
            if (error?.name === 'AbortError')
                throw new SeamlessMcpError('TIMEOUT', `Seamless MCP tools/list timed out after ${this.timeoutMs}ms`);
            throw error;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async searchContacts(args) {
        return this.callTool('search_contacts', args);
    }
    async researchContacts(args) {
        return this.callTool('research_contacts', args);
    }
    async pollContactResearch(args) {
        return this.callTool('poll_contact_research', args);
    }
    async getCredits() {
        return this.callTool('get_credits', {});
    }
    normalizeToolResult(result) {
        const text = [];
        const structured = [];
        for (const item of Array.isArray(result?.content) ? result.content : []) {
            if (typeof item?.text === 'string')
                text.push(item.text);
        }
        for (const value of [result?.structuredContent, result?.data, result?.result]) {
            if (value !== undefined)
                structured.push(value);
        }
        for (const t of text) {
            const parsed = parseJsonText(t);
            if (parsed !== undefined)
                structured.push(parsed);
        }
        return { raw: result, text, structured };
    }
}
exports.SeamlessMcpClient = SeamlessMcpClient;
