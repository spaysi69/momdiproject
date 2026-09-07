import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCredits} from '../dist/src/mcp/credits.js';
const p=data=>parseCredits({structured:[data],text:[],raw:data});
test('credit buckets remain separate instead of selecting the first or summing',()=>{const r=p({daily:{remaining:2},universal:{remaining:500}});assert.equal(r.remaining,null);assert.deepEqual(r.balances.map(b=>b.remaining),[2,500]);assert.match(r.balances[0].label,/daily/)});
test('used credits are never shown as remaining',()=>{assert.equal(p({used:2,total:100}).remaining,null)});
test('single reported balance preserves zero and numeric strings',()=>{assert.equal(p({creditsRemaining:'500'}).remaining,500);assert.equal(p({remaining:0}).remaining,0)});
test('unrecognized response is available for inspection without guessing',()=>{const data={creditLimit:1000,consumed:2};assert.deepEqual(p(data).raw,[data]);assert.equal(p(data).remaining,null)});
