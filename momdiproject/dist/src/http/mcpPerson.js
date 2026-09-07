"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseMcpContacts = parseMcpContacts;
exports.parseResearchResponse = parseResearchResponse;
exports.searchPersonByLinkedIn = searchPersonByLinkedIn;
const searchSchema_1 = require("../mcp/searchSchema");
function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function str(...values) {
    for (const v of values)
        if (typeof v === 'string' && v.trim())
            return v.trim();
    return undefined;
}
function bool(...values) {
    for (const v of values)
        if (typeof v === 'boolean')
            return v;
    return undefined;
}
function collectObjects(value, out, depth = 0, onlySearchRecords = true) {
    if (depth > 7 || value == null)
        return;
    if (Array.isArray(value)) {
        for (const x of value)
            collectObjects(x, out, depth + 1, onlySearchRecords);
        return;
    }
    const obj = asObject(value);
    if (!obj)
        return;
    if (!onlySearchRecords || str(obj.searchResultId, obj.search_result_id, obj.resultId))
        out.push(obj);
    for (const child of Object.values(obj))
        collectObjects(child, out, depth + 1, onlySearchRecords);
}
function parseMarkdownTable(text) {
    const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const tables = [];
    for (let i = 0; i < lines.length - 2; i++) {
        if (!lines[i].includes('|') || !/^\|?\s*:?-{2,}/.test(lines[i + 1]))
            continue;
        const headers = lines[i].split('|').map(x => x.trim()).filter(Boolean);
        const rows = [];
        for (let j = i + 2; j < lines.length && lines[j].includes('|'); j++)
            rows.push(lines[j].replace(/^\|/, '').replace(/\|$/, '').split('|').map(x => x.trim()));
        for (const row of rows) {
            const obj = {};
            const aliases = { searchresultid: 'searchResultId', fullname: 'fullName', name: 'fullName', jobtitle: 'title', companyname: 'company', company: 'company', title: 'title', email: 'email', phone: 'phone', linkedin: 'linkedinUrl', linkedinurl: 'linkedinUrl', companydomain: 'companyDomain' };
            headers.forEach((h, idx) => obj[aliases[h.toLowerCase().replace(/[^a-z]/g, '')] || h] = row[idx]);
            tables.push(obj);
        }
        i += rows.length + 1;
    }
    return tables.filter(x => Object.keys(x).length > 0);
}
function fromRawObject(obj) {
    const id = str(obj.searchResultId, obj.search_result_id, obj.resultId);
    if (!id)
        return null;
    const firstName = str(obj.firstName, obj.first_name);
    const lastName = str(obj.lastName, obj.last_name);
    const fullName = str(obj.fullName, obj.full_name, obj.name) ?? ([firstName, lastName].filter(Boolean).join(' ') || undefined);
    const linkedinUrl = str(obj.liProfileUrl, obj.lIProfileUrl, obj.linkedinUrl, obj.linkedin_url, obj.li_profile_url);
    const company = str(obj.company, obj.companyName, obj.company_name);
    return {
        searchResultId: id,
        fullName, firstName, lastName,
        title: str(obj.title, obj.jobTitle, obj.job_title),
        company,
        email: str(obj.email, obj.email1),
        phone: str(obj.phone, obj.contactPhone1, obj.contact_phone_1),
        linkedinUrl: linkedinUrl ?? '',
        department: str(obj.department),
        seniority: str(obj.seniority),
        companyDomain: str(obj.companyDomain, obj.company_domain, obj.website),
        companyLinkedInUrl: str(obj.companyLIProfileUrl, obj.companyLinkedInUrl, obj.companyLinkedinUrl),
        current: bool(obj.current, obj.isCurrent, obj.currentRole),
        startDate: str(obj.startDate, obj.start, obj.from),
        endDate: str(obj.endDate, obj.end, obj.to),
        raw: obj,
    };
}
function parseMcpContacts(result, fallbackLinkedin) {
    const objects = [];
    for (const x of result.structured)
        collectObjects(x, objects, 0, true);
    for (const text of result.text)
        for (const row of parseMarkdownTable(text))
            objects.push(row);
    const out = [];
    const seen = new Set();
    for (const obj of objects) {
        const candidate = fromRawObject(obj);
        if (!candidate)
            continue;
        if (!candidate.linkedinUrl)
            candidate.linkedinUrl = fallbackLinkedin;
        const key = candidate.searchResultId;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(candidate);
    }
    return out;
}
function extractRequestIds(result) {
    const ids = [];
    const visit = (value, depth = 0) => {
        if (depth > 8 || value == null)
            return;
        if (Array.isArray(value)) {
            for (const x of value)
                visit(x, depth + 1);
            return;
        }
        const obj = asObject(value);
        if (!obj)
            return;
        for (const key of ['requestIds', 'request_ids', 'requestId', 'request_id', 'apiResearchId']) {
            const v = obj[key];
            if (Array.isArray(v)) {
                for (const x of v)
                    if (typeof x === 'string' || typeof x === 'number')
                        ids.push(String(x));
            }
            else if (typeof v === 'string' || typeof v === 'number')
                ids.push(String(v));
        }
        for (const child of Object.values(obj))
            visit(child, depth + 1);
    };
    for (const x of result.structured)
        visit(x);
    for (const text of result.text) {
        const parsed = (() => { try {
            return JSON.parse(text);
        }
        catch {
            return null;
        } })();
        if (parsed)
            visit(parsed);
    }
    return [...new Set(ids)];
}
function parseResearchResponse(result, fallbackLinkedin, requestId) {
    const requestIds = [...(requestId ? [requestId] : []), ...extractRequestIds(result)].filter((x, i, a) => a.indexOf(x) === i);
    const objects = [];
    for (const x of result.structured)
        collectObjects(x, objects, 0, false);
    const contact = objects.find(x => str(x.fullName, x.name, x.firstName) && (str(x.email, x.email1, x.email1Selected, x.phone, x.liProfileUrl, x.linkedinUrl, x.company, x.companyName))) ?? null;
    let data;
    if (contact) {
        data = {
            id: str(contact.contactId, contact.id),
            fullName: str(contact.fullName, contact.name) || [contact.firstName, contact.lastName].filter(Boolean).join(' '),
            firstName: str(contact.firstName),
            lastName: str(contact.lastName),
            title: str(contact.title, contact.jobTitle),
            company: str(contact.company, contact.companyName),
            email: str(contact.email, contact.email1, contact.email1Selected),
            phone: str(contact.phone, contact.contactPhone1),
            linkedinUrl: str(contact.liProfileUrl, contact.lIProfileUrl, contact.linkedinUrl) ?? fallbackLinkedin,
            department: str(contact.department),
            seniority: str(contact.seniority),
            alternateEmails: [contact.email2, contact.email3, contact.personalEmail].map(x => typeof x === 'string' && x.trim() ? x.trim() : undefined).filter(Boolean),
            alternatePhones: [contact.contactPhone2, contact.companyPhone1, contact.companyPhone2, contact.companyPhone3].map(x => typeof x === 'string' && x.trim() ? x.trim() : undefined).filter(Boolean),
            companyDomain: str(contact.companyDomain, contact.website, contact.companyWebsite),
            companyLinkedInUrl: str(contact.companyLIProfileUrl, contact.companyLinkedInUrl),
            contactLocation: contact.contactLocation && typeof contact.contactLocation === 'object' ? contact.contactLocation : undefined,
            companyLocation: contact.companyLocation && typeof contact.companyLocation === 'object' ? contact.companyLocation : undefined,
            raw: contact,
        };
    }
    let status;
    for (const x of objects) {
        status = str(x.status, x.state);
        if (status)
            break;
    }
    return { requestIds, status, data };
}
async function searchPersonByLinkedIn(mcp, linkedinUrl) {
    const tool = (await mcp.listTools()).find(x => x.name === 'search_contacts');
    const args = (0, searchSchema_1.linkedInSearchArguments)(tool?.inputSchema, linkedinUrl);
    if (!args)
        throw new Error('The app could not identify a supported LinkedIn URL filter in search_contacts. This is not an authorization error. Use Copy search diagnostic so the actual tool schema can be checked. No paid lookup was attempted.');
    const raw = await mcp.searchContacts(args);
    return parseMcpContacts(mcp.normalizeToolResult(raw), linkedinUrl);
}
