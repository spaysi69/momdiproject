"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SeamlessClient = void 0;
const axios_1 = __importDefault(require("axios"));
const zod_1 = require("zod");
const ResearchAcceptedSchema = zod_1.z.object({
    success: zod_1.z.boolean().optional(),
    requestIds: zod_1.z.array(zod_1.z.string().min(1)).min(1),
});
const PollEnvelopeSchema = zod_1.z.object({
    success: zod_1.z.boolean().optional(),
    data: zod_1.z.array(zod_1.z.object({
        requestId: zod_1.z.string().optional(),
        searchResultId: zod_1.z.string().optional(),
        status: zod_1.z.string(),
        message: zod_1.z.string().optional(),
        contact: zod_1.z.record(zod_1.z.string(), zod_1.z.any()).optional(),
        additionalData: zod_1.z.record(zod_1.z.string(), zod_1.z.any()).optional(),
    })).min(1),
});
const SearchResultSchema = zod_1.z.record(zod_1.z.string(), zod_1.z.any());
const SearchEnvelopeSchema = zod_1.z.object({
    data: zod_1.z.array(SearchResultSchema).default([]),
    supplementalData: zod_1.z.object({
        isMore: zod_1.z.boolean().optional(),
        total: zod_1.z.number().optional(),
        perPage: zod_1.z.number().optional(),
        nextToken: zod_1.z.string().nullable().optional(),
    }).optional(),
});
function stringOrUndefined(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function firstString(...values) {
    for (const value of values) {
        const result = stringOrUndefined(value);
        if (result)
            return result;
    }
    return undefined;
}
function mapContact(contact, fallbackLinkedInUrl) {
    const firstName = firstString(contact.firstName, contact.first_name);
    const lastName = firstString(contact.lastName, contact.last_name);
    const fullName = firstString(contact.fullName, contact.full_name, contact.name) ?? ([firstName, lastName].filter(Boolean).join(' ') || undefined);
    const linkedinUrl = firstString(contact.lIProfileUrl, contact.liProfileUrl, contact.linkedinUrl, contact.linkedin_url, fallbackLinkedInUrl);
    return {
        id: firstString(contact.contactId, contact.id),
        fullName,
        firstName,
        lastName,
        title: firstString(contact.title, contact.jobTitle),
        company: firstString(contact.company, contact.companyName),
        email: firstString(contact.email, contact.email1),
        phone: firstString(contact.contactPhone1, contact.phone),
        linkedinUrl: linkedinUrl ?? '',
        department: firstString(contact.department),
        seniority: firstString(contact.seniority),
        alternateEmails: [contact.email2, contact.email3, contact.personalEmail].map(stringOrUndefined).filter((v) => Boolean(v)),
        alternatePhones: [contact.contactPhone2, contact.companyPhone1, contact.companyPhone2, contact.companyPhone3].map(stringOrUndefined).filter((v) => Boolean(v)),
        companyDomain: firstString(contact.companyDomain, contact.website, contact.companyWebsite),
        companyLinkedInUrl: firstString(contact.companyLIProfileUrl, contact.companyLinkedInUrl),
        contactLocation: contact.contactLocation && typeof contact.contactLocation === 'object' ? contact.contactLocation : undefined,
        companyLocation: contact.companyLocation && typeof contact.companyLocation === 'object' ? contact.companyLocation : undefined,
        raw: contact,
    };
}
function providerErrorMessage(error) {
    const body = error.response?.data ?? error.data;
    if (body && typeof body === 'object') {
        return String(body.msg ?? body.message ?? body.error ?? error.message ?? 'Provider request failed');
    }
    return error.message ?? 'Provider request failed';
}
class SeamlessClient {
    options;
    client;
    constructor(options) {
        this.options = options;
        this.client = axios_1.default.create({
            baseURL: options.baseUrl.replace(/\/$/, ''),
            timeout: options.timeoutMs,
            headers: {
                'Content-Type': 'application/json',
                Token: options.apiKey,
            },
            validateStatus: () => true,
        });
    }
    throwIfBad(response, acceptedStatus, label) {
        if (response.status !== acceptedStatus) {
            const error = new Error(providerErrorMessage(response));
            error.response = response;
            error.context = label;
            throw error;
        }
    }
    async searchCompanies(query, limit = 20) {
        const response = await this.client.post('/search/companies', {
            nextToken: null,
            limit: Math.min(Math.max(1, limit), 50),
            companyName: [query],
            companyNameSearchType: 'default',
        });
        this.throwIfBad(response, 200, 'company search');
        const parsed = SearchEnvelopeSchema.parse(response.data);
        return {
            companies: parsed.data.map(item => item),
            total: parsed.supplementalData?.total,
            nextToken: parsed.supplementalData?.nextToken,
        };
    }
    async searchContacts(input) {
        const body = {
            nextToken: input.nextToken ?? null,
            limit: Math.min(Math.max(1, input.limit ?? 20), 100),
        };
        if (input.companyName?.trim())
            body.companyName = [input.companyName.trim()];
        if (input.companyDomain?.trim())
            body.companyDomain = [input.companyDomain.trim().replace(/^https?:\/\//, '').replace(/\/$/, '')];
        if (!body.companyName && !body.companyDomain)
            throw new Error('A company name or company domain is required.');
        const response = await this.client.post('/search/contacts', body);
        this.throwIfBad(response, 200, 'contact search');
        const parsed = SearchEnvelopeSchema.parse(response.data);
        return {
            contacts: parsed.data
                .filter(item => stringOrUndefined(item.searchResultId))
                .map(item => item),
            total: parsed.supplementalData?.total,
            nextToken: parsed.supplementalData?.nextToken,
        };
    }
    async researchContactBySearchResultId(searchResultId, skipDeduplicationCheck = false, onAccepted) {
        const accepted = await this.client.post('/contacts/research', {
            searchResultIds: [searchResultId],
            skipDeduplicationCheck,
        });
        this.throwIfBad(accepted, 202, 'contact research');
        const parsed = ResearchAcceptedSchema.parse(accepted.data);
        if (onAccepted)
            await onAccepted();
        const requestId = parsed.requestIds[0];
        for (let poll = 1; poll <= this.options.maxPolls; poll += 1) {
            const response = await this.client.get('/contacts/research/poll', {
                params: { requestIds: requestId },
            });
            this.throwIfBad(response, 200, 'contact research poll');
            const result = PollEnvelopeSchema.parse(response.data).data[0];
            const status = result.status.toLowerCase();
            if (status === 'done' || status === 'duplicate') {
                if (!result.contact)
                    throw new Error('Seamless returned a completed result without contact data');
                return mapContact(result.contact);
            }
            if (status === 'missing')
                throw new Error('Seamless could not find this contact');
            if (status === 'error')
                throw new Error(result.message || 'Seamless contact research failed');
            await new Promise(resolve => setTimeout(resolve, this.options.pollIntervalMs));
        }
        const error = new Error('Seamless contact research timed out while polling');
        error.code = 'ETIMEDOUT';
        throw error;
    }
    async researchContactByLinkedInUrl(linkedinUrl, skipDeduplicationCheck = false) {
        const accepted = await this.client.post('/contacts/research', {
            contacts: [{ liProfileUrl: linkedinUrl }],
            skipDeduplicationCheck,
        });
        this.throwIfBad(accepted, 202, 'contact research');
        const parsed = ResearchAcceptedSchema.parse(accepted.data);
        const requestId = parsed.requestIds[0];
        for (let poll = 1; poll <= this.options.maxPolls; poll += 1) {
            const response = await this.client.get('/contacts/research/poll', {
                params: { requestIds: requestId },
            });
            this.throwIfBad(response, 200, 'contact research poll');
            const result = PollEnvelopeSchema.parse(response.data).data[0];
            const status = result.status.toLowerCase();
            if (status === 'done' || status === 'duplicate') {
                if (!result.contact)
                    throw new Error('Seamless returned a completed result without contact data');
                return mapContact(result.contact, linkedinUrl);
            }
            if (status === 'missing')
                throw new Error('Seamless could not find this LinkedIn profile');
            if (status === 'error')
                throw new Error(result.message || 'Seamless research failed');
            await new Promise(resolve => setTimeout(resolve, this.options.pollIntervalMs));
        }
        const error = new Error('Seamless research timed out while polling');
        error.code = 'ETIMEDOUT';
        throw error;
    }
}
exports.SeamlessClient = SeamlessClient;
