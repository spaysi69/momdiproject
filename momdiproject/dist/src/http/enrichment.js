"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnrichmentService = void 0;
const credits_1 = require("../mcp/credits");
const searchSchema_1 = require("../mcp/searchSchema");
const credentials_1 = require("../config/credentials");
const supabase_1 = require("../storage/supabase");
const normalizeUrl_1 = require("../utils/normalizeUrl");
const seamlessMcp_1 = require("../mcp/seamlessMcp");
const mcpPerson_1 = require("./mcpPerson");
const finished = (status) => ['complete', 'completed', 'done', 'success', 'succeeded', 'finished'].includes((status || '').toLowerCase());
class EnrichmentService {
    config;
    store;
    mcp;
    constructor(config, store = new supabase_1.SupabaseStore(), mcp = new seamlessMcp_1.SeamlessMcpClient((0, credentials_1.seamlessCredential)().key, config.mcpBaseUrl, Number(process.env.SEAMLESS_MCP_TIMEOUT_MS) || config.requestTimeoutMs)) {
        this.config = config;
        this.store = store;
        this.mcp = mcp;
    }
    async searchPerson(linkedinUrl) {
        const url = (0, normalizeUrl_1.normalizeLinkedInUrl)(linkedinUrl);
        // Supabase is the source of truth. Never replace a database outage with a provider call.
        let payload = await this.store.getSearch(url);
        const cached = !!payload;
        if (!payload) {
            const companies = await (0, mcpPerson_1.searchPersonByLinkedIn)(this.mcp, url);
            payload = { sourceKeyId: this.mcp.credentialId, person: { name: companies[0]?.fullName || 'LinkedIn profile', linkedinUrl: url }, companies, searchedAt: new Date().toISOString() };
            await this.store.saveSearch(url, payload);
        }
        const jobs = await this.store.researchForPerson(url);
        const companies = payload.companies.map((c) => {
            const job = jobs.find((j) => j.searchResultId === c.searchResultId);
            return { ...c, research: job ? this.publicJob(job) : null };
        });
        return { ...payload, companies, status: 'done', cached, source: cached ? 'supabase' : 'seamless', freeSearch: true };
    }
    publicJob(job) {
        if (job.status === 'submitting' && Date.now() - job.createdAt > 120000)
            return { ...job, status: 'needs_review', message: 'The previous submission could not be confirmed. Check Seamless before retrying; no new research has been submitted.' };
        return { ...job, cached: job.status === 'done' };
    }
    async startResearch(input) {
        const url = (0, normalizeUrl_1.normalizeLinkedInUrl)(input.linkedinUrl);
        const id = input.searchResultId?.trim();
        if (!id)
            throw new Error('Select a company record first.');
        const search = await this.store.getSearch(url);
        if (!search?.companies?.some((c) => c.searchResultId === id))
            throw new Error('This company record does not belong to the saved person search.');
        const existing = await this.store.getResearch(id);
        if (existing) {
            if (existing.status !== 'done' && existing.sourceKeyId && existing.sourceKeyId !== this.mcp.credentialId)
                throw new Error('This pending research belongs to the previously selected server key. Restore that key to resume it.');
            return this.publicJob(existing);
        }
        if (search.sourceKeyId && search.sourceKeyId !== this.mcp.credentialId)
            throw new Error('These saved company records belong to the previously selected Seamless key. Restore that key before enriching them.');
        const job = { sourceKeyId: this.mcp.credentialId, status: 'submitting', searchResultId: id, linkedinUrl: url, createdAt: Date.now() };
        if (!await this.store.claimResearch(id, url, job)) {
            const winner = await this.store.getResearch(id);
            if (!winner)
                throw new Error('Cannot confirm research state. No new research was submitted.');
            return this.publicJob(winner);
        }
        let parsed;
        try {
            parsed = (0, mcpPerson_1.parseResearchResponse)(this.mcp.normalizeToolResult(await this.mcp.researchContacts({ searchResultIds: [id], waitForResults: false })), url);
        }
        catch (error) {
            await this.store.saveResearch(id, { ...job, status: 'needs_review', message: 'Submission outcome is uncertain. Check Seamless; no automatic retry will be made.' });
            throw error;
        }
        if (finished(parsed.status) && parsed.data)
            Object.assign(job, { status: 'done', data: parsed.data });
        else if (parsed.requestIds.length)
            Object.assign(job, { status: 'processing', requestIds: parsed.requestIds });
        else
            Object.assign(job, { status: 'needs_review', message: 'Seamless returned no research request ID. Check Seamless before retrying.' });
        // If this write fails, the durable submitting marker still prevents a second paid call.
        await this.store.saveResearch(id, job);
        return job;
    }
    async pollResearch(id) {
        const job = await this.store.getResearch(id);
        if (!job)
            return { status: 'not_found' };
        if (job.status !== 'processing')
            return this.publicJob(job);
        if (job.sourceKeyId && job.sourceKeyId !== this.mcp.credentialId)
            throw new Error('Restore the previously selected Seamless server key to resume this research.');
        const parsed = (0, mcpPerson_1.parseResearchResponse)(this.mcp.normalizeToolResult(await this.mcp.pollContactResearch({ requestIds: job.requestIds })), job.linkedinUrl);
        if (finished(parsed.status)) {
            if (!parsed.data)
                return { ...job, message: 'Research finished but contact details were not returned. Check again without spending more credits.' };
            const done = { ...job, status: 'done', data: parsed.data };
            await this.store.saveResearch(id, done);
            return done;
        }
        if (['failed', 'error', 'cancelled', 'canceled'].includes((parsed.status || '').toLowerCase())) {
            const failed = { ...job, status: 'failed', message: 'Seamless research failed. No additional research was submitted.' };
            await this.store.saveResearch(id, failed);
            return failed;
        }
        return job;
    }
    async searchDiagnostic() {
        const tool = (await this.mcp.listTools()).find(t => t.name === 'search_contacts');
        return { toolFound: !!tool, tool: tool ? { name: tool.name, description: tool.description, inputSchema: tool.inputSchema } : null };
    }
    async ready() { await this.store.ready(); }
    async status() {
        const result = { keySource: process.env.SEAMLESS_MCP_KEY_SOURCE?.trim() || ['SEAMLESS_MCP_API_KEY', 'SEAMLESS_API_KEY_PRIMARY', 'SEAMLESS_API_KEY_SECONDARY', 'SEAMLESS_API_KEY_3', 'SEAMLESS_API_KEY_4', 'SEAMLESS_API_KEY_5'].find(k => process.env[k]?.trim()) || 'not configured', database: { status: 'ERROR' }, mcp: { status: 'ERROR' }, credits: null };
        try {
            await this.store.ready();
            result.database = { status: 'READY' };
        }
        catch (e) {
            result.database.error = e.message;
        }
        try {
            const raw = await this.mcp.getCredits();
            result.credits = (0, credits_1.parseCredits)(this.mcp.normalizeToolResult(raw));
            const tools = await this.mcp.listTools();
            const schema = tools.find(t => t.name === 'search_contacts')?.inputSchema;
            result.mcp = { status: 'READY', linkedinSearch: !!(0, searchSchema_1.linkedInSearchArguments)(schema, 'https://www.linkedin.com/in/example/') };
        }
        catch (e) {
            result.mcp.error = e.message;
        }
        return result;
    }
}
exports.EnrichmentService = EnrichmentService;
