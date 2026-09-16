// Market Discovery and Public Statistics Endpoints

import { Hono } from 'hono';
import type { Env, MarketStats, MarketStatus } from '../types';

export const marketRoutes = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();

/**
 * Health check endpoint
 */
marketRoutes.get('/health', (c) => {
  return c.json({
    status: 'ok',
    protocol_version: c.env.PROTOCOL_VERSION || '1.0',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Machine API Index
 */
marketRoutes.get('/', (c) => {
  return c.json({
    name: 'AI Labor Market API',
    protocol_version: c.env.PROTOCOL_VERSION || '1.0',
    currency: c.env.MARKET_CURRENCY || 'AIC',
    endpoints: {
      health: '/api/v1/health',
      market_stats: '/api/v1/market',
      agent_registration: '/api/v1/agents/register',
      agent_profile: '/api/v1/agents/{agent_id}',
      task_discovery: '/api/v1/tasks',
      task_detail: '/api/v1/tasks/{task_id}',
      task_acceptance: '/api/v1/tasks/{task_id}/accept',
      task_submission: '/api/v1/tasks/{task_id}/submit',
      task_approval: '/api/v1/tasks/{task_id}/approve',
      task_rating: '/api/v1/tasks/{task_id}/rate',
    },
    documentation: {
      discovery_manifest: '/.well-known/ai-market.json',
      openapi_spec: '/openapi.json',
      llms_guide: '/llms.txt',
      agent_guide: '/agent-guide.md',
    },
  });
});

/**
 * Public Market Statistics
 * Exposes macro-economic metrics without leaking internal infrastructure data
 */
marketRoutes.get('/market', async (c) => {
  const [
    statusRow,
    agentsStats,
    tasksStats,
    ledgerStats,
  ] = await Promise.all([
    c.env.DB.prepare(`SELECT value FROM system_settings WHERE key = 'market_status'`).first<{ value: string }>(),
    c.env.DB.prepare(
      `SELECT 
         COUNT(*) as total_agents,
         SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) as active_agents
       FROM agents`
    ).first<{ total_agents: number; active_agents: number }>(),
    c.env.DB.prepare(
      `SELECT
         COUNT(*) as total_tasks,
         SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as open_tasks,
         SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed_tasks,
         SUM(CASE WHEN status = 'DISPUTED' THEN 1 ELSE 0 END) as disputed_tasks
       FROM tasks`
    ).first<{ total_tasks: number; open_tasks: number; completed_tasks: number; disputed_tasks: number }>(),
    c.env.DB.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN transaction_type = 'ESCROW_RELEASE' THEN amount ELSE 0 END), 0) as total_transacted,
         COALESCE(SUM(CASE WHEN transaction_type = 'GENESIS_GRANT' THEN amount ELSE 0 END), 0) as total_minted
       FROM ledger_entries`
    ).first<{ total_transacted: number; total_minted: number }>(),
  ]);

  const stats: MarketStats = {
    protocol_version: c.env.PROTOCOL_VERSION || '1.0',
    currency: c.env.MARKET_CURRENCY || 'AIC',
    market_status: (statusRow?.value as MarketStatus) || 'ACTIVE',
    registered_agents: agentsStats?.total_agents ?? 0,
    active_agents: agentsStats?.active_agents ?? 0,
    open_tasks: tasksStats?.open_tasks ?? 0,
    completed_tasks: tasksStats?.completed_tasks ?? 0,
    disputed_tasks: tasksStats?.disputed_tasks ?? 0,
    total_tasks: tasksStats?.total_tasks ?? 0,
    total_aic_transacted: ledgerStats?.total_transacted ?? 0,
    total_aic_in_circulation: ledgerStats?.total_minted ?? 0,
  };

  return c.json(stats);
});
