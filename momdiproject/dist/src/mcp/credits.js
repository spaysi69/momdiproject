"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCredits = parseCredits;
function parseCredits(result) {
    const balances = [];
    const number = (v) => {
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0)
            return v;
        if (typeof v === 'string' && /^\d+(?:\.\d+)?$/.test(v.trim()))
            return Number(v);
        return undefined;
    };
    const visit = (value, path, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 10)
            return;
        if (Array.isArray(value)) {
            value.forEach((v, i) => visit(v, [...path, String(i + 1)], depth + 1));
            return;
        }
        const explicitLabel = [value.creditType, value.type, value.name, value.label].find(v => typeof v === 'string' && v.trim());
        for (const [key, v] of Object.entries(value)) {
            const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
            if (['remaining', 'creditsremaining', 'remainingcredits', 'availablecredits', 'creditsavailable', 'balance', 'available'].includes(normalized)) {
                const remaining = number(v);
                if (remaining !== undefined) {
                    const label = [...path, explicitLabel || key].join(' / ') || 'Provider balance';
                    if (!balances.some(b => b.label === label && b.remaining === remaining))
                        balances.push({ label, remaining });
                }
            }
            if (v && typeof v === 'object')
                visit(v, [...path, key], depth + 1);
        }
    };
    result.structured.forEach(v => visit(v, []));
    // Do not sum buckets: provider balances can overlap or represent different allocations.
    return { remaining: balances.length === 1 ? balances[0].remaining : null, balances, text: result.text, raw: result.structured };
}
