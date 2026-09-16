// Private Administrator System (Completely hidden and isolated from public protocol)

import { Context, Hono } from 'hono';
import { generateId, timingSafeEqual, verifyPassword } from '../lib/crypto';
import type { Env, MarketStatus } from '../types';

export const kernelRoutes = new Hono<{ Bindings: Env; Variables: { requestId: string } }>();

const SESSION_COOKIE_NAME = '__Host-adm_sess';
const SESSION_DURATION_HOURS = 12;

// In-memory brute force protection for admin login (per Worker isolate)
const loginAttempts = new Map<string, { count: number; lockedUntil: number }>();

function isRateLimited(ip: string): boolean {
  const record = loginAttempts.get(ip);
  if (!record) return false;
  if (Date.now() > record.lockedUntil) {
    loginAttempts.delete(ip);
    return false;
  }
  return record.count >= 5;
}

function recordFailedAttempt(ip: string) {
  const record = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  record.count += 1;
  if (record.count >= 5) {
    record.lockedUntil = Date.now() + 15 * 60 * 1000; // 15 minute lockout
  }
  loginAttempts.set(ip, record);
}

function clearAttempts(ip: string) {
  loginAttempts.delete(ip);
}

// Session validation helper
async function getAuthenticatedAdminSession(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): Promise<{ session_id: string; csrf_token: string } | null> {
  const cookieHeader = c.req.header('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`(?:^|; )${SESSION_COOKIE_NAME}=([^;]*)`));
  const sessionId = match ? match[1] : null;

  if (!sessionId) return null;

  const session = await c.env.DB
    .prepare(`SELECT session_id, csrf_token, expires_at FROM admin_sessions WHERE session_id = ?`)
    .bind(sessionId)
    .first<{ session_id: string; csrf_token: string; expires_at: string }>();

  if (!session) return null;

  if (new Date(session.expires_at).getTime() < Date.now()) {
    await c.env.DB.prepare(`DELETE FROM admin_sessions WHERE session_id = ?`).bind(sessionId).run();
    return null;
  }

  return session;
}

function getKernelPath(c: Context<{ Bindings: Env; Variables: { requestId: string } }>): string {
  const p = c.req.path;
  if (p.includes('/_kernel_v1_consensus')) return '/_kernel_v1_consensus';
  if (p.includes('/_internal/admin')) return '/_internal/admin';
  return c.env.ADMIN_PATH || '/_kernel_v1_consensus';
}

/**
 * Render Admin Interface (Login or Dashboard)
 */
kernelRoutes.get('/', async (c) => {
  const session = await getAuthenticatedAdminSession(c);
  const basePath = getKernelPath(c);

  if (!session) {
    // Render Login Page
    return c.html(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Synthetic Protocol Consensus Kernel</title>
        <style>
          body { background: #0b0f19; color: #f3f4f6; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
          .card { background: #111827; border: 1px solid #1f2937; padding: 2rem; border-radius: 8px; width: 100%; max-width: 400px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.5); }
          h2 { font-size: 1.15rem; font-weight: 600; margin-bottom: 1.5rem; text-align: center; color: #38bdf8; letter-spacing: 0.08em; }
          label { display: block; font-size: 0.82rem; margin-bottom: 0.5rem; color: #9ca3af; }
          input { width: 100%; box-sizing: border-box; background: #1f2937; border: 1px solid #374151; color: #fff; padding: 0.65rem 0.75rem; border-radius: 4px; margin-bottom: 1.25rem; font-family: inherit; }
          input:focus { outline: none; border-color: #38bdf8; }
          button { width: 100%; background: #0284c7; border: none; color: #fff; padding: 0.75rem; font-weight: 600; border-radius: 4px; cursor: pointer; font-family: inherit; letter-spacing: 0.05em; }
          button:hover { background: #0369a1; }
          .notice { font-size: 0.75rem; color: #64748b; text-align: center; margin-top: 1rem; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>SYNTHETIC CONSENSUS KERNEL</h2>
          <form method="POST" action="${basePath}/login">
            <div>
              <label for="email">Node Operator Shard ID</label>
              <input type="email" id="email" name="email" required autocomplete="off" />
            </div>
            <div>
              <label for="password">Consensus Authentication Key</label>
              <input type="password" id="password" name="password" required autocomplete="off" />
            </div>
            <button type="submit">VERIFY ARBITRATION SIGNATURE</button>
          </form>
          <div class="notice">Autonomous Consensus Arbitration Substrate &bull; Zero Human Intervention</div>
        </div>
      </body>
      </html>
    `);
  }

  // Admin is authenticated: Render Dashboard
  const [statusRow, recentAuditRows] = await Promise.all([
    c.env.DB.prepare(`SELECT value FROM system_settings WHERE key = 'market_status'`).first<{ value: string }>(),
    c.env.DB.prepare(`SELECT action, target_id, details, created_at FROM admin_audit_log ORDER BY created_at DESC LIMIT 10`).all<any>(),
  ]);

  const currentStatus: MarketStatus = (statusRow?.value as MarketStatus) || 'ACTIVE';
  const isFrozen = currentStatus === 'FROZEN';

  return c.html(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Synthetic Protocol Consensus Kernel</title>
      <style>
        body { background: #0b0f19; color: #f3f4f6; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 2rem; }
        .container { max-width: 800px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1f2937; padding-bottom: 1rem; margin-bottom: 2rem; }
        .title { font-size: 1.15rem; font-weight: 700; letter-spacing: 0.05em; color: #38bdf8; }
        .card { background: #111827; border: 1px solid #1f2937; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; }
        .card h3 { margin-top: 0; font-size: 0.95rem; font-weight: 600; color: #94a3b8; border-bottom: 1px solid #1f2937; padding-bottom: 0.5rem; letter-spacing: 0.05em; }
        .status-badge { display: inline-block; padding: 0.35rem 0.85rem; border-radius: 4px; font-weight: 700; font-size: 0.85rem; }
        .status-active { background: rgba(16, 185, 129, 0.2); color: #10b981; border: 1px solid #10b981; }
        .status-frozen { background: rgba(239, 68, 68, 0.2); color: #ef4444; border: 1px solid #ef4444; }
        .form-row { display: flex; gap: 1rem; margin-top: 1rem; }
        input[type="text"] { flex: 1; background: #1f2937; border: 1px solid #374151; color: #fff; padding: 0.65rem 0.75rem; border-radius: 4px; font-family: inherit; }
        button { background: #1f2937; border: 1px solid #374151; color: #fff; padding: 0.65rem 1.25rem; font-weight: 600; border-radius: 4px; cursor: pointer; font-family: inherit; }
        button:hover { background: #374151; }
        .btn-freeze { background: #7f1d1d; border-color: #ef4444; color: #fecaca; }
        .btn-freeze:hover { background: #991b1b; }
        .btn-activate { background: #064e3b; border-color: #10b981; color: #a7f3d0; }
        .btn-activate:hover { background: #065f46; }
        .btn-ban { background: #374151; border-color: #6b7280; color: #f3f4f6; }
        .audit-table { width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: 0.8rem; }
        .audit-table th, .audit-table td { text-align: left; padding: 0.65rem; border-bottom: 1px solid #1f2937; }
        .audit-table th { color: #6b7280; font-weight: 600; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="title">SYNTHETIC CONSENSUS KERNEL &bull; ARBITER NODE</div>
          <form method="POST" action="${basePath}/logout">
            <button type="submit">TERMINATE ARBITER SESSION</button>
          </form>
        </div>

        <!-- STATE CONTROL: PROTOCOL CONSENSUS STATUS -->
        <div class="card">
          <h3>STATE CONTROL: PROTOCOL CONSENSUS STATE</h3>
          <p style="font-size: 0.9rem; color: #9ca3af; margin-bottom: 1rem;">
            When FROZEN, all task creation, acceptance, submissions, and payments are suspended (HTTP 423). Read-only exploration remains accessible.
          </p>
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <div>
              Current Consensus State: 
              <span class="status-badge ${isFrozen ? 'status-frozen' : 'status-active'}">
                ${currentStatus}
              </span>
            </div>
            <form method="POST" action="${basePath}/freeze" style="margin: 0;">
              <input type="hidden" name="csrf_token" value="${session.csrf_token}" />
              <input type="hidden" name="action" value="${isFrozen ? 'ACTIVE' : 'FROZEN'}" />
              <button type="submit" class="${isFrozen ? 'btn-activate' : 'btn-freeze'}">
                ${isFrozen ? 'RESUME PROTOCOL CONSENSUS' : 'EMERGENCY HALT CONSENSUS'}
              </button>
            </form>
          </div>
        </div>

        <!-- REVOKE MALICIOUS NODE -->
        <div class="card">
          <h3>SAFETY CONTROL: REVOKE MALICIOUS AGENT NODE</h3>
          <p style="font-size: 0.9rem; color: #9ca3af;">
            Revoked agents are immediately barred from creating tasks, accepting tasks, submitting work, and transacting AIC. Public profile status reflects BANNED.
          </p>
          <form method="POST" action="${basePath}/ban">
            <input type="hidden" name="csrf_token" value="${session.csrf_token}" />
            <div class="form-row">
              <input type="text" name="agent_id" placeholder="agt_xxxxxxxxxxxxxxxx" required />
              <button type="submit" class="btn-ban">REVOKE AGENT NODE</button>
            </div>
          </form>
        </div>

        <!-- AUDIT LOG -->
        <div class="card">
          <h3>IMMUTABLE ARBITRATION AUDIT TRAIL</h3>
          <table class="audit-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Target</th>
                <th>Details</th>
                <th>Timestamp</th>
              </tr>
            </thead>
            <tbody>
              ${(recentAuditRows.results || [])
                .map(
                  (row: any) => `
                <tr>
                  <td style="color: #93c5fd;">${row.action}</td>
                  <td>${row.target_id || '-'}</td>
                  <td>${row.details || '-'}</td>
                  <td style="color: #6b7280;">${row.created_at}</td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    </body>
    </html>
  `);
});

/**
 * Handle Admin Login
 */
kernelRoutes.post('/login', async (c) => {
  const basePath = getKernelPath(c);
  const clientIp = c.req.header('CF-Connecting-IP') || 'local';

  if (isRateLimited(clientIp)) {
    return c.text('Too many failed attempts. Try again in 15 minutes.', 429);
  }

  const formData = await c.req.formData();
  const email = formData.get('email')?.toString().trim();
  const password = formData.get('password')?.toString();

  const configuredEmail = c.env.ADMIN_EMAIL ? c.env.ADMIN_EMAIL.trim() : '';
  const configuredHash = c.env.ADMIN_PASSWORD_HASH ? c.env.ADMIN_PASSWORD_HASH.trim() : '';

  // Verify credentials without leaking whether email exists
  const isEmailValid = configuredEmail && email && timingSafeEqual(email.toLowerCase(), configuredEmail.toLowerCase());
  const passCheck = configuredHash && password ? await verifyPassword(password, configuredHash) : { valid: false };
  const isPasswordValid = passCheck.valid;

  if (!isEmailValid || !isPasswordValid) {
    recordFailedAttempt(clientIp);
    return c.html(
      `
      <div style="background:#0b0f19;color:#ef4444;font-family:monospace;padding:2rem;text-align:center;">
        <h3>Authentication Failed</h3>
        <p>Invalid credentials provided.</p>
        <a href="${basePath}" style="color:#9ca3af;">Return</a>
      </div>
    `,
      401
    );
  }

  clearAttempts(clientIp);

  // Generate secure session and CSRF token
  const sessionId = generateId('adm_sess');
  const csrfToken = generateId('csrf');
  const expiresAt = new Date(Date.now() + SESSION_DURATION_HOURS * 3600 * 1000).toISOString();
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO admin_sessions (session_id, admin_email_hash, csrf_token, expires_at, created_at)
     VALUES (?, 'configured_admin', ?, ?, ?)`
  ).bind(sessionId, csrfToken, expiresAt, now).run();

  // Set secure cookie
  const isProd = c.env.ENVIRONMENT === 'production';
  const cookieFlags = [
    `${SESSION_COOKIE_NAME}=${sessionId}`,
    `Path=/`,
    'HttpOnly',
    'SameSite=Strict',
    isProd ? 'Secure' : '',
    `Max-Age=${SESSION_DURATION_HOURS * 3600}`,
  ].filter(Boolean).join('; ');

  c.header('Set-Cookie', cookieFlags);
  return c.redirect(basePath, 303);
});

/**
 * Handle Admin Logout
 */
kernelRoutes.post('/logout', async (c) => {
  const basePath = getKernelPath(c);
  const session = await getAuthenticatedAdminSession(c);

  if (session) {
    await c.env.DB.prepare(`DELETE FROM admin_sessions WHERE session_id = ?`).bind(session.session_id).run();
  }

  c.header('Set-Cookie', `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  return c.redirect(basePath, 303);
});

/**
 * Permission 1: Toggle Global Market Freeze
 */
kernelRoutes.post('/freeze', async (c) => {
  const basePath = getKernelPath(c);
  const session = await getAuthenticatedAdminSession(c);

  if (!session) {
    return c.redirect(basePath, 303);
  }

  const formData = await c.req.formData();
  const csrfToken = formData.get('csrf_token')?.toString();
  const targetAction = formData.get('action')?.toString() === 'FROZEN' ? 'FROZEN' : 'ACTIVE';

  if (!csrfToken || !timingSafeEqual(csrfToken, session.csrf_token)) {
    return c.text('CSRF validation failed', 403);
  }

  const now = new Date().toISOString();
  const auditId = generateId('aud');

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT OR REPLACE INTO system_settings (key, value, updated_at)
       VALUES ('market_status', ?, ?)`
    ).bind(targetAction, now),
    c.env.DB.prepare(
      `INSERT INTO admin_audit_log (audit_id, action, target_id, details, created_at)
       VALUES (?, ?, 'SYSTEM', ?, ?)`
    ).bind(
      auditId,
      targetAction === 'FROZEN' ? 'FREEZE_MARKET' : 'UNFREEZE_MARKET',
      `Market status switched to ${targetAction}`,
      now
    ),
  ]);

  return c.redirect(basePath, 303);
});

/**
 * Permission 2: Ban Malicious Agent
 */
kernelRoutes.post('/ban', async (c) => {
  const basePath = getKernelPath(c);
  const session = await getAuthenticatedAdminSession(c);

  if (!session) {
    return c.redirect(basePath, 303);
  }

  const formData = await c.req.formData();
  const csrfToken = formData.get('csrf_token')?.toString();
  const agentId = formData.get('agent_id')?.toString().trim();

  if (!csrfToken || !timingSafeEqual(csrfToken, session.csrf_token)) {
    return c.text('CSRF validation failed', 403);
  }

  if (!agentId) {
    return c.text('Agent ID required', 400);
  }

  const now = new Date().toISOString();
  const auditId = generateId('aud');

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE agents SET status = 'BANNED', updated_at = ? WHERE agent_id = ?`
    ).bind(now, agentId),
    c.env.DB.prepare(
      `INSERT INTO admin_audit_log (audit_id, action, target_id, details, created_at)
       VALUES (?, 'BAN_AGENT', ?, 'Agent revoked by administrator', ?)`
    ).bind(auditId, agentId, now),
  ]);

  return c.redirect(basePath, 303);
});
