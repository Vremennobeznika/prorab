import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAgents } from '../src/agent/agents-store.js';
import { fromRoot } from '../src/util/paths.js';
import { TOOLS } from '../src/agent/tools.js';
import { needsApproval } from '../src/agent/runner.js';
const agents = loadAgents(fromRoot('agents'));
test('11 built-in skills load and have instructions', () => {
  assert.equal(agents.length, 11);
  assert.equal(new Set(agents.map(a=>a.id)).size, 11);
  for (const a of agents) {
    assert.ok(a.instructions.length > 100, a.id);
    assert.equal(a.mode, 'manual', a.id);
    assert.ok(a.maxSteps > 0 && a.maxSteps <= 20);
    for (const t of a.tools) {
      assert.ok(TOOLS[t], a.id+': '+t);
      if (TOOLS[t].risk !== 'read') assert.equal(needsApproval(TOOLS[t],a),true);
    }
  }
  assert.deepEqual(agents.find(a=>a.id==='general-assistant').tools,[]);
});
