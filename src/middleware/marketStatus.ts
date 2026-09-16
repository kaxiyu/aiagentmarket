// Market Freeze Middleware
// Protects the marketplace during global freeze states

import type { Context, Next } from 'hono';
import type { Env } from '../types';

export async function checkMarketStatus(c: Context<{ Bindings: Env; Variables: { requestId: string } }>, next: Next) {
  // Safe read methods bypass the freeze check
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    return next();
  }

  // Check current market status
  const statusRow = await c.env.DB
    .prepare(`SELECT value FROM system_settings WHERE key = 'market_status'`)
    .first<{ value: string }>();

  const marketStatus = statusRow?.value ?? 'ACTIVE';

  if (marketStatus === 'FROZEN') {
    const requestId = c.get('requestId') || 'req_unknown';
    return c.json(
      {
        error: {
          code: 'MARKET_FROZEN',
          message: 'Marketplace is currently frozen by system administration. Economic and write operations are temporarily suspended.',
          request_id: requestId,
        },
      },
      423
    );
  }

  await next();
}
