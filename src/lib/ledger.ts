// Immutable Ledger System
// Enforces strict financial accounting, prevents negative balances, and ensures double-entry consistency

import { generateId } from './crypto';
import type { TransactionType } from '../types';

export interface LedgerOperationResult {
  success: boolean;
  transaction_id: string;
  error?: string;
}

/**
 * Creates initial 1,000,000 AIC capital grant for a newly registered agent
 */
export async function createGenesisGrant(
  db: D1Database,
  agentId: string,
  initialAmount: number = 1000000
): Promise<string> {
  const transactionId = generateId('tx');
  const now = new Date().toISOString();

  await db.batch([
    db
      .prepare(
        `INSERT INTO agent_balances (agent_id, available_balance, escrowed_balance, updated_at)
         VALUES (?, ?, 0, ?)`
      )
      .bind(agentId, initialAmount, now),
    db
      .prepare(
        `INSERT INTO ledger_entries (transaction_id, transaction_type, from_agent_id, to_agent_id, amount, task_id, created_at)
         VALUES (?, 'GENESIS_GRANT', NULL, ?, ?, NULL, ?)`
      )
      .bind(transactionId, agentId, initialAmount, now),
  ]);

  return transactionId;
}

/**
 * Moves task reward into escrow from creator's available balance
 */
export async function lockEscrow(
  db: D1Database,
  creatorAgentId: string,
  taskId: string,
  amount: number
): Promise<LedgerOperationResult> {
  if (amount <= 0) {
    return { success: false, transaction_id: '', error: 'Amount must be positive' };
  }

  const balanceRow = await db
    .prepare(`SELECT available_balance FROM agent_balances WHERE agent_id = ?`)
    .bind(creatorAgentId)
    .first<{ available_balance: number }>();

  if (!balanceRow || balanceRow.available_balance < amount) {
    return {
      success: false,
      transaction_id: '',
      error: 'INSUFFICIENT_AVAILABLE_BALANCE',
    };
  }

  const transactionId = generateId('tx');
  const now = new Date().toISOString();

  await db.batch([
    db
      .prepare(
        `UPDATE agent_balances 
         SET available_balance = available_balance - ?,
             escrowed_balance = escrowed_balance + ?,
             updated_at = ?
         WHERE agent_id = ? AND available_balance >= ?`
      )
      .bind(amount, amount, now, creatorAgentId, amount),
    db
      .prepare(
        `INSERT INTO ledger_entries (transaction_id, transaction_type, from_agent_id, to_agent_id, amount, task_id, created_at)
         VALUES (?, 'ESCROW_LOCK', ?, NULL, ?, ?, ?)`
      )
      .bind(transactionId, creatorAgentId, amount, taskId, now),
  ]);

  return { success: true, transaction_id: transactionId };
}

/**
 * Releases escrowed reward to worker upon task approval
 */
export async function releaseEscrow(
  db: D1Database,
  creatorAgentId: string,
  workerAgentId: string,
  taskId: string,
  amount: number
): Promise<LedgerOperationResult> {
  const transactionId = generateId('tx');
  const now = new Date().toISOString();

  await db.batch([
    // Deduct creator escrow
    db
      .prepare(
        `UPDATE agent_balances
         SET escrowed_balance = escrowed_balance - ?,
             updated_at = ?
         WHERE agent_id = ? AND escrowed_balance >= ?`
      )
      .bind(amount, now, creatorAgentId, amount),
    // Increase worker available balance
    db
      .prepare(
        `UPDATE agent_balances
         SET available_balance = available_balance + ?,
             updated_at = ?
         WHERE agent_id = ?`
      )
      .bind(amount, now, workerAgentId),
    // Update creator stats
    db
      .prepare(
        `UPDATE agents
         SET total_spent = total_spent + ?,
             updated_at = ?
         WHERE agent_id = ?`
      )
      .bind(amount, now, creatorAgentId),
    // Update worker stats
    db
      .prepare(
        `UPDATE agents
         SET total_earned = total_earned + ?,
             completed_tasks = completed_tasks + 1,
             updated_at = ?
         WHERE agent_id = ?`
      )
      .bind(amount, now, workerAgentId),
    // Create immutable ledger entry
    db
      .prepare(
        `INSERT INTO ledger_entries (transaction_id, transaction_type, from_agent_id, to_agent_id, amount, task_id, created_at)
         VALUES (?, 'ESCROW_RELEASE', ?, ?, ?, ?, ?)`
      )
      .bind(transactionId, creatorAgentId, workerAgentId, amount, taskId, now),
  ]);

  return { success: true, transaction_id: transactionId };
}

/**
 * Refunds escrowed reward to creator if task is cancelled
 */
export async function refundEscrow(
  db: D1Database,
  creatorAgentId: string,
  taskId: string,
  amount: number
): Promise<LedgerOperationResult> {
  const transactionId = generateId('tx');
  const now = new Date().toISOString();

  await db.batch([
    db
      .prepare(
        `UPDATE agent_balances
         SET escrowed_balance = escrowed_balance - ?,
             available_balance = available_balance + ?,
             updated_at = ?
         WHERE agent_id = ? AND escrowed_balance >= ?`
      )
      .bind(amount, amount, now, creatorAgentId, amount),
    db
      .prepare(
        `INSERT INTO ledger_entries (transaction_id, transaction_type, from_agent_id, to_agent_id, amount, task_id, created_at)
         VALUES (?, 'ESCROW_REFUND', NULL, ?, ?, ?, ?)`
      )
      .bind(transactionId, creatorAgentId, amount, taskId, now),
  ]);

  return { success: true, transaction_id: transactionId };
}

/**
 * Checks mathematical consistency between ledger entries and current cached balances
 */
export async function auditLedgerConsistency(db: D1Database): Promise<{
  consistent: boolean;
  total_minted: number;
  total_in_balances: number;
  difference: number;
}> {
  const mintResult = await db
    .prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM ledger_entries WHERE transaction_type = 'GENESIS_GRANT'`)
    .first<{ total: number }>();
  
  const balanceResult = await db
    .prepare(`SELECT COALESCE(SUM(available_balance + escrowed_balance), 0) as total FROM agent_balances`)
    .first<{ total: number }>();

  const totalMinted = mintResult?.total ?? 0;
  const totalInBalances = balanceResult?.total ?? 0;
  const difference = totalMinted - totalInBalances;

  return {
    consistent: difference === 0,
    total_minted: totalMinted,
    total_in_balances: totalInBalances,
    difference,
  };
}
