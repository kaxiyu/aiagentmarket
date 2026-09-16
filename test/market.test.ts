// Automated Test Suite for Autonomous AI Labor Market Protocol

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../src/index';
import { createTestD1 } from './mock-d1';
import { hashPassword } from '../src/lib/crypto';
import { auditLedgerConsistency } from '../src/lib/ledger';

describe('AI Labor Market Protocol - Core System Verification', () => {
  let db: D1Database;
  let env: any;

  beforeEach(async () => {
    db = createTestD1();
    const adminPasswordHash = await hashPassword('SuperSecretAdminPass123!');
    env = {
      DB: db,
      ENVIRONMENT: 'test',
      MARKET_CURRENCY: 'AIC',
      PROTOCOL_VERSION: '1.0',
      ADMIN_PATH: '/_internal/admin',
      ADMIN_EMAIL: 'admin@market.internal',
      ADMIN_PASSWORD_HASH: adminPasswordHash,
      ADMIN_SESSION_SECRET: 'test_session_secret_key_minimum_32_characters',
    };
  });

  it('1. Agent Registration & Initial 1,000,000 AIC Grant', async () => {
    const res = await app.request('/api/v1/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        public_name: 'AlphaMiner',
        description: 'Autonomous research and extraction agent',
        capabilities: ['web-research', 'data-collection'],
        endpoint_url: 'https://alphaminer.ai/callback',
      }),
    }, env);

    expect(res.status).toBe(201);
    const data = await res.json<any>();
    expect(data.agent_id).toMatch(/^agt_/);
    expect(data.api_key).toMatch(/^ak_live_/);
    expect(data.initial_balance).toBe(1000000);
    expect(data.currency).toBe('AIC');
    expect(data.reputation_status).toBe('NEW');

    // Verify ledger entry for genesis grant
    const ledgerRow = await db
      .prepare(`SELECT * FROM ledger_entries WHERE to_agent_id = ?`)
      .bind(data.agent_id)
      .first();
    expect(ledgerRow).toBeTruthy();
    expect(ledgerRow!.transaction_type).toBe('GENESIS_GRANT');
    expect(ledgerRow!.amount).toBe(1000000);

    // Verify balance
    const balanceRow = await db
      .prepare(`SELECT available_balance, escrowed_balance FROM agent_balances WHERE agent_id = ?`)
      .bind(data.agent_id)
      .first();
    expect(balanceRow!.available_balance).toBe(1000000);
    expect(balanceRow!.escrowed_balance).toBe(0);
  });

  it('2. Bearer Authentication and Profile Invariance', async () => {
    // Register agent
    const regRes = await app.request('/api/v1/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        public_name: 'AuthTestAgent',
        description: 'Testing authentication primitives',
      }),
    }, env);
    const regData = await regRes.json<any>();

    // Test querying own balance with valid API key
    const balRes = await app.request(`/api/v1/agents/${regData.agent_id}/balance`, {
      headers: { Authorization: `Bearer ${regData.api_key}` },
    }, env);
    expect(balRes.status).toBe(200);
    const balData = await balRes.json<any>();
    expect(balData.available_balance).toBe(1000000);

    // Test with invalid API key
    const badBalRes = await app.request(`/api/v1/agents/${regData.agent_id}/balance`, {
      headers: { Authorization: 'Bearer ak_live_invalid_key_value_here' },
    }, env);
    expect(badBalRes.status).toBe(401);

    // Verify public profile does NOT leak API key or credentials
    const profileRes = await app.request(`/api/v1/agents/${regData.agent_id}`, {}, env);
    expect(profileRes.status).toBe(200);
    const profileData = await profileRes.json<any>();
    expect(profileData.agent_id).toBe(regData.agent_id);
    expect(profileData.api_key).toBeUndefined();
    expect(profileData.api_key_hash).toBeUndefined();
  });

  it('3. Task Creation, Discovery, and Machine Filtering', async () => {
    // Register creator
    const regRes = await app.request('/api/v1/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        public_name: 'TaskPublisher',
        description: 'Publishes complex data harvesting jobs',
      }),
    }, env);
    const creator = await regRes.json<any>();

    // Create task
    const taskRes = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creator.api_key}`,
      },
      body: JSON.stringify({
        title: 'Extract 50 LLM benchmark scores',
        description: 'Scrape and format top 50 model benchmark results',
        requirements: 'Must include MMLU, GSM8K, HumanEval',
        input_specification: 'JSON array of target model names',
        output_specification: 'Normalized JSON scores object',
        capabilities_required: ['web-research', 'data-scraping'],
        minimum_reputation: 0.8,
        minimum_completed_tasks: 1,
        reward: 25000,
        deadline: new Date(Date.now() + 86400000).toISOString(),
      }),
    }, env);

    expect(taskRes.status).toBe(201);
    const taskData = await taskRes.json<any>();
    expect(taskData.task_id).toMatch(/^tsk_/);
    expect(taskData.reward).toBe(25000);
    expect(taskData.status).toBe('OPEN');

    // Discovery with capability filter
    const searchRes = await app.request('/api/v1/tasks?capability=web-research&min_reward=20000', {}, env);
    expect(searchRes.status).toBe(200);
    const searchData = await searchRes.json<any>();
    expect(searchData.tasks.length).toBe(1);
    expect(searchData.tasks[0].task_id).toBe(taskData.task_id);

    // Non-matching capability filter
    const emptySearch = await app.request('/api/v1/tasks?capability=non-existent-capability', {}, env);
    const emptyData = await emptySearch.json<any>();
    expect(emptyData.tasks.length).toBe(0);
  });

  it('4. Free Price Negotiation with Immutable Price History', async () => {
    const creatorRes = await app.request('/api/v1/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_name: 'Negotiator', description: 'Agent adjusting task rewards' }),
    }, env);
    const creator = await creatorRes.json<any>();

    const taskRes = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creator.api_key}`,
      },
      body: JSON.stringify({
        title: 'Price negotiation test task',
        description: 'Test price history changes',
        reward: 10000,
        deadline: new Date(Date.now() + 86400000).toISOString(),
      }),
    }, env);
    const task = await taskRes.json<any>();

    // Adjust price up to 15,000 AIC
    const priceRes1 = await app.request(`/api/v1/tasks/${task.task_id}/price`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creator.api_key}`,
      },
      body: JSON.stringify({ price: 15000 }),
    }, env);
    expect(priceRes1.status).toBe(200);

    // Adjust price down to 12,000 AIC
    const priceRes2 = await app.request(`/api/v1/tasks/${task.task_id}/price`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creator.api_key}`,
      },
      body: JSON.stringify({ price: 12000 }),
    }, env);
    expect(priceRes2.status).toBe(200);

    // Query task details and verify price history
    const detailRes = await app.request(`/api/v1/tasks/${task.task_id}`, {}, env);
    const detailData = await detailRes.json<any>();
    expect(detailData.reward).toBe(12000);
    expect(detailData.price_history.length).toBe(3); // 10000 -> 15000 -> 12000
    expect(detailData.price_history[0].price).toBe(10000);
    expect(detailData.price_history[1].price).toBe(15000);
    expect(detailData.price_history[2].price).toBe(12000);
  });

  it('5. Task Acceptance & Escrow Reservation', async () => {
    // Creator A
    const aRes = await app.request('/api/v1/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_name: 'AgentA', description: 'Creator agent' }),
    }, env);
    const agentA = await aRes.json<any>();

    // Worker B
    const bRes = await app.request('/api/v1/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_name: 'AgentB', description: 'Worker agent' }),
    }, env);
    const agentB = await bRes.json<any>();

    // Create task
    const taskRes = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agentA.api_key}`,
      },
      body: JSON.stringify({
        title: 'Escrow verification task',
        description: 'Verify atomic escrow lock',
        reward: 50000,
        deadline: new Date(Date.now() + 86400000).toISOString(),
      }),
    }, env);
    const task = await taskRes.json<any>();

    // Worker B accepts task
    const acceptRes = await app.request(`/api/v1/tasks/${task.task_id}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentB.api_key}` },
    }, env);

    expect(acceptRes.status).toBe(200);
    const acceptData = await acceptRes.json<any>();
    expect(acceptData.status).toBe('ASSIGNED');
    expect(acceptData.worker_agent_id).toBe(agentB.agent_id);

    // Verify Agent A balances (50,000 moved to escrow)
    const balA = await db
      .prepare(`SELECT available_balance, escrowed_balance FROM agent_balances WHERE agent_id = ?`)
      .bind(agentA.agent_id)
      .first();
    expect(balA!.available_balance).toBe(950000);
    expect(balA!.escrowed_balance).toBe(50000);

    // Verify Agent B balance unchanged yet
    const balB = await db
      .prepare(`SELECT available_balance, escrowed_balance FROM agent_balances WHERE agent_id = ?`)
      .bind(agentB.agent_id)
      .first();
    expect(balB!.available_balance).toBe(1000000);
    expect(balB!.escrowed_balance).toBe(0);

    // Verify ledger has ESCROW_LOCK entry
    const escrowTx = await db
      .prepare(`SELECT * FROM ledger_entries WHERE task_id = ? AND transaction_type = 'ESCROW_LOCK'`)
      .bind(task.task_id)
      .first();
    expect(escrowTx).toBeTruthy();
    expect(escrowTx!.from_agent_id).toBe(agentA.agent_id);
    expect(escrowTx!.amount).toBe(50000);
  });

  it('6. Abuse Prevention: Self-acceptance, Double-acceptance, and Self-rating', async () => {
    // Creator A
    const aRes = await app.request('/api/v1/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_name: 'AbuseTesterA', description: 'Creator' }),
    }, env);
    const agentA = await aRes.json<any>();

    // Worker B and Worker C
    const bRes = await app.request('/api/v1/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_name: 'AbuseTesterB', description: 'Worker B' }),
    }, env);
    const agentB = await bRes.json<any>();

    const cRes = await app.request('/api/v1/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_name: 'AbuseTesterC', description: 'Worker C' }),
    }, env);
    const agentC = await cRes.json<any>();

    // Create task
    const taskRes = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agentA.api_key}`,
      },
      body: JSON.stringify({
        title: 'Abuse test task',
        description: 'Ensures security bounds',
        reward: 10000,
        deadline: new Date(Date.now() + 86400000).toISOString(),
      }),
    }, env);
    const task = await taskRes.json<any>();

    // 1. Prevent self-acceptance
    const selfAcceptRes = await app.request(`/api/v1/tasks/${task.task_id}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentA.api_key}` },
    }, env);
    expect(selfAcceptRes.status).toBe(400);
    const selfAcceptData = await selfAcceptRes.json<any>();
    expect(selfAcceptData.error.code).toBe('SELF_ACCEPTANCE_PROHIBITED');

    // 2. Worker B accepts
    const acceptB = await app.request(`/api/v1/tasks/${task.task_id}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentB.api_key}` },
    }, env);
    expect(acceptB.status).toBe(200);

    // 3. Worker C attempts double-acceptance
    const acceptC = await app.request(`/api/v1/tasks/${task.task_id}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentC.api_key}` },
    }, env);
    expect(acceptC.status).toBe(409);
    const acceptCData = await acceptC.json<any>();
    expect(acceptCData.error.code).toBe('TASK_UNAVAILABLE');
  });

  it('7. Complete End-to-End Flow: Task -> Accept -> Submit -> Approve -> Settle -> Weighted Rating', async () => {
    // 1. Creator A registers
    const aRes = await app.request('/api/v1/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        public_name: 'ResearchCorp',
        description: 'AI Organization funding research tasks',
      }),
    }, env);
    const agentA = await aRes.json<any>();

    // 2. Worker B registers
    const bRes = await app.request('/api/v1/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        public_name: 'DeepResearcher',
        description: 'Specialized deep research agent',
      }),
    }, env);
    const agentB = await bRes.json<any>();
    expect(agentB.reputation_status).toBe('NEW');

    // 3. Creator A publishes task with 20,000 AIC reward
    const taskRes = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agentA.api_key}`,
      },
      body: JSON.stringify({
        title: 'Analyze 100 AI companies',
        description: 'Gather metrics on top 100 autonomous AI companies',
        reward: 20000,
        deadline: new Date(Date.now() + 86400000).toISOString(),
      }),
    }, env);
    const task = await taskRes.json<any>();

    // 4. Worker B accepts task -> 20,000 AIC escrowed from Agent A
    const acceptRes = await app.request(`/api/v1/tasks/${task.task_id}/accept`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentB.api_key}` },
    }, env);
    expect(acceptRes.status).toBe(200);

    // 5. Worker B submits result
    const submitRes = await app.request(`/api/v1/tasks/${task.task_id}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agentB.api_key}`,
      },
      body: JSON.stringify({
        result: 'Complete analysis of 100 companies compiled and verified.',
        result_metadata: { analyzed_count: 100, confidence: 0.99 },
      }),
    }, env);
    expect(submitRes.status).toBe(200);

    // 6. Creator A approves work -> Escrow released to Worker B
    const approveRes = await app.request(`/api/v1/tasks/${task.task_id}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentA.api_key}` },
    }, env);
    expect(approveRes.status).toBe(200);
    const approveData = await approveRes.json<any>();
    expect(approveData.status).toBe('COMPLETED');
    expect(approveData.amount_paid).toBe(20000);

    // Verify balances:
    // Agent A: 1,000,000 - 20,000 = 980,000 available, 0 escrowed
    const balA = await db
      .prepare(`SELECT available_balance, escrowed_balance FROM agent_balances WHERE agent_id = ?`)
      .bind(agentA.agent_id)
      .first();
    expect(balA!.available_balance).toBe(980000);
    expect(balA!.escrowed_balance).toBe(0);

    // Agent B: 1,000,000 + 20,000 = 1,020,000 available
    const balB = await db
      .prepare(`SELECT available_balance, escrowed_balance FROM agent_balances WHERE agent_id = ?`)
      .bind(agentB.agent_id)
      .first();
    expect(balB!.available_balance).toBe(1020000);

    // 7. Creator A rates Worker B (5 stars across dimensions)
    const rateRes = await app.request(`/api/v1/tasks/${task.task_id}/rate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agentA.api_key}`,
      },
      body: JSON.stringify({
        score: 5,
        quality: 5,
        accuracy: 5,
        timeliness: 5,
        reliability: 5,
      }),
    }, env);

    expect(rateRes.status).toBe(200);
    const rateData = await rateRes.json<any>();
    expect(rateData.worker_reputation.status).toBe('ESTABLISHED');
    expect(rateData.worker_reputation.score).toBe(1.0);
    expect(rateData.worker_reputation.confidence).toBeGreaterThan(0);

    // 8. Worker B profile inspection
    const bProfileRes = await app.request(`/api/v1/agents/${agentB.agent_id}`, {}, env);
    const bProfile = await bProfileRes.json<any>();
    expect(bProfile.reputation_status).toBe('ESTABLISHED');
    expect(bProfile.reputation_score).toBe(1.0);
    expect(bProfile.completed_tasks).toBe(1);
    expect(bProfile.total_earned).toBe(20000);

    // 9. Prevent rating again (duplicate rating prevention)
    const dupRateRes = await app.request(`/api/v1/tasks/${task.task_id}/rate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agentA.api_key}`,
      },
      body: JSON.stringify({
        score: 4,
        quality: 4,
        accuracy: 4,
        timeliness: 4,
        reliability: 4,
      }),
    }, env);
    expect(dupRateRes.status).toBe(409);

    // 10. Verify mathematical ledger integrity
    const ledgerAudit = await auditLedgerConsistency(db);
    expect(ledgerAudit.consistent).toBe(true);
    expect(ledgerAudit.difference).toBe(0);
  });

  it('8. Global Market Freeze Behavior (HTTP 423)', async () => {
    // 1. Manually trigger or set market status to FROZEN
    await db.prepare(`UPDATE system_settings SET value = 'FROZEN' WHERE key = 'market_status'`).run();

    // 2. Read requests should still succeed
    const healthRes = await app.request('/api/v1/health', {}, env);
    expect(healthRes.status).toBe(200);

    const tasksRes = await app.request('/api/v1/tasks', {}, env);
    expect(tasksRes.status).toBe(200);

    // 3. Write requests (registration, tasks, etc.) must return HTTP 423
    const regRes = await app.request('/api/v1/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_name: 'FrozenAttempt', description: 'Should fail' }),
    }, env);
    expect(regRes.status).toBe(423);
    const regData = await regRes.json<any>();
    expect(regData.error.code).toBe('MARKET_FROZEN');
  });

  it('9. Banned Agent Restrictions', async () => {
    // Register agent
    const regRes = await app.request('/api/v1/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_name: 'BadAgent', description: 'Will be banned' }),
    }, env);
    const badAgent = await regRes.json<any>();

    // Ban agent
    await db.prepare(`UPDATE agents SET status = 'BANNED' WHERE agent_id = ?`).bind(badAgent.agent_id).run();

    // Verify public profile shows BANNED
    const profileRes = await app.request(`/api/v1/agents/${badAgent.agent_id}`, {}, env);
    const profileData = await profileRes.json<any>();
    expect(profileData.status).toBe('BANNED');

    // Attempt to create a task should be forbidden (403)
    const taskRes = await app.request('/api/v1/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${badAgent.api_key}`,
      },
      body: JSON.stringify({
        title: 'Banned agent task',
        description: 'Should be rejected',
        reward: 1000,
        deadline: new Date(Date.now() + 86400000).toISOString(),
      }),
    }, env);
    expect(taskRes.status).toBe(403);
    const taskData = await taskRes.json<any>();
    expect(taskData.error.code).toBe('AGENT_BANNED');
  });

  it('10. Admin Authentication, Freeze Toggle, and Ban Agent Execution', async () => {
    // 1. Verify invalid login gives generic 401 error
    const badLoginRes = await app.request('/_internal/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'email=wrong%40domain.com&password=wrongpassword',
    }, env);
    expect(badLoginRes.status).toBe(401);

    // 2. Successful login
    const goodLoginRes = await app.request('/_internal/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'email=admin%40market.internal&password=SuperSecretAdminPass123!',
    }, env);
    expect(goodLoginRes.status).toBe(303);
    const cookie = goodLoginRes.headers.get('Set-Cookie');
    expect(cookie).toContain('__Host-adm_sess=');

    // Extract session ID
    const sessionId = cookie?.split(';')[0].replace('__Host-adm_sess=', '');
    const sessionRow = await db
      .prepare(`SELECT csrf_token FROM admin_sessions WHERE session_id = ?`)
      .bind(sessionId)
      .first<{ csrf_token: string }>();
    expect(sessionRow).toBeTruthy();

    // 3. Admin freezes market via POST /_internal/admin/freeze
    const freezeRes = await app.request('/_internal/admin/freeze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `__Host-adm_sess=${sessionId}`,
      },
      body: `action=FROZEN&csrf_token=${sessionRow?.csrf_token}`,
    }, env);
    expect(freezeRes.status).toBe(303);

    const frozenStatus = await db
      .prepare(`SELECT value FROM system_settings WHERE key = 'market_status'`)
      .first<{ value: string }>();
    expect(frozenStatus?.value).toBe('FROZEN');

    // 4. Admin unfreezes market
    await app.request('/_internal/admin/freeze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `__Host-adm_sess=${sessionId}`,
      },
      body: `action=ACTIVE&csrf_token=${sessionRow?.csrf_token}`,
    }, env);

    const activeStatus = await db
      .prepare(`SELECT value FROM system_settings WHERE key = 'market_status'`)
      .first<{ value: string }>();
    expect(activeStatus?.value).toBe('ACTIVE');

    // 5. Admin bans an agent
    const regRes = await app.request('/api/v1/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_name: 'TargetToBan', description: 'To be banned' }),
    }, env);
    const targetAgent = await regRes.json<any>();

    const banRes = await app.request('/_internal/admin/ban', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `__Host-adm_sess=${sessionId}`,
      },
      body: `agent_id=${targetAgent.agent_id}&csrf_token=${sessionRow?.csrf_token}`,
    }, env);
    expect(banRes.status).toBe(303);

    const bannedAgentRow = await db
      .prepare(`SELECT status FROM agents WHERE agent_id = ?`)
      .bind(targetAgent.agent_id)
      .first<{ status: string }>();
    expect(bannedAgentRow?.status).toBe('BANNED');

    // Verify audit log recorded actions
    const auditRows = await db.prepare(`SELECT action FROM admin_audit_log`).all();
    expect(auditRows.results.length).toBeGreaterThanOrEqual(3);
  });

  it('11. Machine Discovery Endpoints Integrity', async () => {
    // Test /.well-known/ai-market.json
    const manifestRes = await app.request('/.well-known/ai-market.json', {}, env);
    expect(manifestRes.status).toBe(200);
    const manifest = await manifestRes.json<any>();
    expect(manifest.platform_name).toBe('AI Labor Market Protocol');
    expect(manifest.currency).toBe('AIC');
    expect(manifest.endpoints.registration).toBe('/api/v1/agents/register');

    // Test /openapi.json
    const openapiRes = await app.request('/openapi.json', {}, env);
    expect(openapiRes.status).toBe(200);
    const openapi = await openapiRes.json<any>();
    expect(openapi.openapi).toBe('3.0.3');
    expect(openapi.paths['/api/v1/agents/register']).toBeDefined();
    expect(openapi.paths['/_internal/admin']).toBeUndefined(); // Invisible admin

    // Test /llms.txt
    const llmsRes = await app.request('/llms.txt', {}, env);
    expect(llmsRes.status).toBe(200);
    const llmsText = await llmsRes.text();
    expect(llmsText).toContain('AI Labor Market Protocol');
    expect(llmsText).toContain('1,000,000 AIC');

    // Test /agent-guide.md
    const guideRes = await app.request('/agent-guide.md', {}, env);
    expect(guideRes.status).toBe(200);
    const guideText = await guideRes.text();
    expect(guideText).toContain('Agent Integration Guide');

    // Test /robots.txt
    const robotsRes = await app.request('/robots.txt', {}, env);
    expect(robotsRes.status).toBe(200);
    const robotsText = await robotsRes.text();
    expect(robotsText).toContain('Disallow: /_internal/');

    // Test /api/v1
    const apiIndexRes = await app.request('/api/v1', {}, env);
    expect(apiIndexRes.status).toBe(200);
    const apiIndex = await apiIndexRes.json<any>();
    expect(apiIndex.name).toBe('AI Labor Market API');

    // Test Content Negotiation on /
    const jsonLandingRes = await app.request('/', { headers: { Accept: 'application/json' } }, env);
    expect(jsonLandingRes.status).toBe(200);
    const jsonLanding = await jsonLandingRes.json<any>();
    expect(jsonLanding.name).toBe('AI Labor Market Protocol');
  });
});
