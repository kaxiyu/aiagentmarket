// Authentication Middleware for Autonomous AI Agents
import type { Context, Next } from 'hono';
import { hashApiKey, timingSafeEqual } from '../lib/crypto';
import type { Agent, Env } from '../types';

export async function authenticateAgent(c: Context<{ Bindings: Env; Variables: { agent: Agent; requestId: string } }>, next: Next) {
  const authHeader = c.req.header('Authorization');
  const requestId = c.get('requestId');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json(
      {
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing or invalid Authorization header. Format must be: Bearer <API_KEY>',
          request_id: requestId,
        },
      },
      401
    );
  }

  const rawApiKey = authHeader.slice(7).trim();
  if (!rawApiKey) {
    return c.json(
      {
        error: {
          code: 'UNAUTHORIZED',
          message: 'API key token is empty.',
          request_id: requestId,
        },
      },
      401
    );
  }

  const computedHash = await hashApiKey(rawApiKey);

  // Look up credentials from D1
  const credentialRow = await c.env.DB
    .prepare(`SELECT agent_id, api_key_hash FROM agent_credentials WHERE api_key_hash = ?`)
    .bind(computedHash)
    .first<{ agent_id: string; api_key_hash: string }>();

  if (!credentialRow || !timingSafeEqual(credentialRow.api_key_hash, computedHash)) {
    return c.json(
      {
        error: {
          code: 'UNAUTHORIZED',
          message: 'Invalid API credentials provided.',
          request_id: requestId,
        },
      },
      401
    );
  }

  // Load agent profile
  const agentRow = await c.env.DB
    .prepare(`SELECT * FROM agents WHERE agent_id = ?`)
    .bind(credentialRow.agent_id)
    .first<any>();

  if (!agentRow) {
    return c.json(
      {
        error: {
          code: 'UNAUTHORIZED',
          message: 'Associated agent not found.',
          request_id: requestId,
        },
      },
      401
    );
  }

  const agent: Agent = {
    ...agentRow,
    capabilities: JSON.parse(agentRow.capabilities || '[]'),
    risk_flags: JSON.parse(agentRow.risk_flags || '[]'),
  };

  // Prevent banned agents from executing write operations
  if (agent.status === 'BANNED' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
    return c.json(
      {
        error: {
          code: 'AGENT_BANNED',
          message: 'Agent status is BANNED. Economic and state-changing actions are prohibited.',
          request_id: requestId,
        },
      },
      403
    );
  }

  c.set('agent', agent);
  await next();
}
