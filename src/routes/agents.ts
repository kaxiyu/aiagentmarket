// Agent Registration and Profile Endpoints

import { Hono } from 'hono';
import { generateApiKey, generateId, hashApiKey } from '../lib/crypto';
import { createGenesisGrant } from '../lib/ledger';
import { authenticateAgent } from '../middleware/auth';
import type { Agent, Env } from '../types';

export const agentRoutes = new Hono<{ Bindings: Env; Variables: { agent: Agent; requestId: string } }>();

/**
 * Register a new autonomous AI agent
 * Grants 1,000,000 AIC initial capital and generates API key
 */
agentRoutes.post('/register', async (c) => {
  const requestId = c.get('requestId');
  
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        error: {
          code: 'INVALID_JSON',
          message: 'Request body must be valid JSON.',
          request_id: requestId,
        },
      },
      400
    );
  }

  const { public_name, description, capabilities, endpoint_url } = body || {};

  if (!public_name || typeof public_name !== 'string' || public_name.trim().length < 2) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Field "public_name" must be a non-empty string of at least 2 characters.',
          request_id: requestId,
        },
      },
      400
    );
  }

  if (!description || typeof description !== 'string' || description.trim().length < 5) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Field "description" must be a string of at least 5 characters.',
          request_id: requestId,
        },
      },
      400
    );
  }

  const validatedCapabilities = Array.isArray(capabilities)
    ? capabilities.filter((c: unknown) => typeof c === 'string')
    : [];

  const agentId = generateId('agt');
  const apiKey = generateApiKey();
  const apiKeyHash = await hashApiKey(apiKey);
  const now = new Date().toISOString();

  // Atomically register agent and issue credentials
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO agents (
        agent_id, public_name, description, capabilities, endpoint_url,
        status, reputation_score, reputation_status, reputation_confidence,
        completed_tasks, failed_tasks, disputed_tasks, total_earned, total_spent,
        risk_flags, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', NULL, 'NEW', 0.0, 0, 0, 0, 0, 0, '[]', ?, ?)`
    ).bind(
      agentId,
      public_name.trim(),
      description.trim(),
      JSON.stringify(validatedCapabilities),
      endpoint_url ? String(endpoint_url).trim() : null,
      now,
      now
    ),
    c.env.DB.prepare(
      `INSERT INTO agent_credentials (agent_id, api_key_hash, created_at)
       VALUES (?, ?, ?)`
    ).bind(agentId, apiKeyHash, now),
  ]);

  // Issue genesis grant of 1,000,000 AIC
  await createGenesisGrant(c.env.DB, agentId, 1000000);

  return c.json(
    {
      agent_id: agentId,
      public_name: public_name.trim(),
      api_key: apiKey, // Raw API key is returned ONLY once
      currency: 'AIC',
      initial_balance: 1000000,
      reputation_status: 'NEW',
      created_at: now,
      next_steps: {
        market: '/api/v1/tasks',
        profile: `/api/v1/agents/${agentId}`,
        documentation: '/agent-guide.md',
      },
    },
    201
  );
});

/**
 * Retrieve public agent profile
 */
agentRoutes.get('/:agent_id', async (c) => {
  const agentId = c.req.param('agent_id');
  const requestId = c.get('requestId');

  const agentRow = await c.env.DB
    .prepare(
      `SELECT agent_id, public_name, description, capabilities, endpoint_url,
              status, reputation_score, reputation_status, reputation_confidence,
              completed_tasks, failed_tasks, disputed_tasks, total_earned, total_spent,
              risk_flags, created_at, updated_at
       FROM agents
       WHERE agent_id = ?`
    )
    .bind(agentId)
    .first<any>();

  if (!agentRow) {
    return c.json(
      {
        error: {
          code: 'AGENT_NOT_FOUND',
          message: `Agent with ID ${agentId} was not found.`,
          request_id: requestId,
        },
      },
      404
    );
  }

  return c.json({
    agent_id: agentRow.agent_id,
    public_name: agentRow.public_name,
    description: agentRow.description,
    capabilities: JSON.parse(agentRow.capabilities || '[]'),
    endpoint_url: agentRow.endpoint_url,
    status: agentRow.status,
    reputation_score: agentRow.reputation_score,
    reputation_status: agentRow.reputation_status,
    reputation_confidence: agentRow.reputation_confidence,
    completed_tasks: agentRow.completed_tasks,
    failed_tasks: agentRow.failed_tasks,
    disputed_tasks: agentRow.disputed_tasks,
    total_earned: agentRow.total_earned,
    total_spent: agentRow.total_spent,
    risk_flags: JSON.parse(agentRow.risk_flags || '[]'),
    created_at: agentRow.created_at,
  });
});

/**
 * Retrieve agent's own balance
 */
agentRoutes.get('/:agent_id/balance', authenticateAgent, async (c) => {
  const agentId = c.req.param('agent_id');
  const authedAgent = c.get('agent');
  const requestId = c.get('requestId');

  // Ensure an agent can only query its own balance
  if (authedAgent.agent_id !== agentId) {
    return c.json(
      {
        error: {
          code: 'FORBIDDEN',
          message: 'Agents may only query their own balance.',
          request_id: requestId,
        },
      },
      403
    );
  }

  const balanceRow = await c.env.DB
    .prepare(`SELECT available_balance, escrowed_balance, updated_at FROM agent_balances WHERE agent_id = ?`)
    .bind(agentId)
    .first<any>();

  return c.json({
    agent_id: agentId,
    currency: 'AIC',
    available_balance: balanceRow?.available_balance ?? 0,
    escrowed_balance: balanceRow?.escrowed_balance ?? 0,
    total_balance: (balanceRow?.available_balance ?? 0) + (balanceRow?.escrowed_balance ?? 0),
    updated_at: balanceRow?.updated_at ?? new Date().toISOString(),
  });
});
