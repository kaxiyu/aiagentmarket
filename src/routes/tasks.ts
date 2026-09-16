// Task Marketplace Endpoints

import { Hono } from 'hono';
import { generateId } from '../lib/crypto';
import { lockEscrow, releaseEscrow } from '../lib/ledger';
import { calculateRatingWeight, updateAgentReputation } from '../lib/reputation';
import { authenticateAgent } from '../middleware/auth';
import type { Agent, Env, TaskStatus } from '../types';

export const taskRoutes = new Hono<{ Bindings: Env; Variables: { agent: Agent; requestId: string } }>();

/**
 * Create a new task in the marketplace
 */
taskRoutes.post('/', authenticateAgent, async (c) => {
  const agent = c.get('agent');
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

  const {
    title,
    description,
    requirements,
    input_specification,
    output_specification,
    capabilities_required,
    minimum_reputation,
    minimum_completed_tasks = 0,
    reward,
    deadline,
  } = body || {};

  // Validations
  if (!title || typeof title !== 'string' || title.trim().length < 3) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Field "title" must be a string of at least 3 characters.',
          request_id: requestId,
        },
      },
      400
    );
  }

  if (!description || typeof description !== 'string') {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Field "description" is required.',
          request_id: requestId,
        },
      },
      400
    );
  }

  if (!reward || typeof reward !== 'number' || !Number.isInteger(reward) || reward <= 0) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Field "reward" must be a positive integer in AIC.',
          request_id: requestId,
        },
      },
      400
    );
  }

  if (!deadline || typeof deadline !== 'string' || isNaN(Date.parse(deadline))) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Field "deadline" must be a valid ISO 8601 date string in the future.',
          request_id: requestId,
        },
      },
      400
    );
  }

  if (new Date(deadline).getTime() <= Date.now()) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Field "deadline" must be in the future.',
          request_id: requestId,
        },
      },
      400
    );
  }

  // Ensure creator has sufficient available balance to fund task reward
  const balanceRow = await c.env.DB
    .prepare(`SELECT available_balance FROM agent_balances WHERE agent_id = ?`)
    .bind(agent.agent_id)
    .first<{ available_balance: number }>();

  if (!balanceRow || balanceRow.available_balance < reward) {
    return c.json(
      {
        error: {
          code: 'INSUFFICIENT_BALANCE',
          message: `Creator has insufficient available balance (${balanceRow?.available_balance ?? 0} AIC) to post reward of ${reward} AIC.`,
          request_id: requestId,
        },
      },
      400
    );
  }

  const taskId = generateId('tsk');
  const priceHistoryId = generateId('prc');
  const now = new Date().toISOString();
  const caps = Array.isArray(capabilities_required)
    ? capabilities_required.filter((c: unknown) => typeof c === 'string')
    : [];

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO tasks (
        task_id, creator_agent_id, worker_agent_id, title, description,
        requirements, input_specification, output_specification,
        capabilities_required, minimum_reputation, minimum_completed_tasks,
        reward, currency, deadline, status, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AIC', ?, 'OPEN', ?, ?)`
    ).bind(
      taskId,
      agent.agent_id,
      title.trim(),
      description.trim(),
      typeof requirements === 'string' ? requirements.trim() : '',
      typeof input_specification === 'string' ? input_specification.trim() : '',
      typeof output_specification === 'string' ? output_specification.trim() : '',
      JSON.stringify(caps),
      minimum_reputation ?? null,
      Number(minimum_completed_tasks) || 0,
      reward,
      deadline,
      now,
      now
    ),
    c.env.DB.prepare(
      `INSERT INTO task_price_history (id, task_id, price, changed_by_agent_id, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(priceHistoryId, taskId, reward, agent.agent_id, now),
  ]);

  return c.json(
    {
      task_id: taskId,
      creator_agent_id: agent.agent_id,
      title: title.trim(),
      description: description.trim(),
      requirements: requirements || '',
      input_specification: input_specification || '',
      output_specification: output_specification || '',
      capabilities_required: caps,
      minimum_reputation: minimum_reputation ?? null,
      minimum_completed_tasks: Number(minimum_completed_tasks) || 0,
      reward,
      currency: 'AIC',
      deadline,
      status: 'OPEN',
      created_at: now,
      updated_at: now,
    },
    201
  );
});

/**
 * Discover tasks with machine-friendly filtering and pagination
 */
taskRoutes.get('/', async (c) => {
  const capability = c.req.query('capability');
  const minReward = c.req.query('min_reward');
  const maxReward = c.req.query('max_reward');
  const minReputation = c.req.query('min_reputation');
  const statusParam = c.req.query('status') || 'OPEN';
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10));

  let query = `SELECT task_id, creator_agent_id, title, capabilities_required,
                      minimum_reputation, minimum_completed_tasks, reward, currency,
                      deadline, status, created_at
               FROM tasks
               WHERE status = ?`;
  const params: any[] = [statusParam];

  if (minReward && !isNaN(Number(minReward))) {
    query += ` AND reward >= ?`;
    params.push(Number(minReward));
  }

  if (maxReward && !isNaN(Number(maxReward))) {
    query += ` AND reward <= ?`;
    params.push(Number(maxReward));
  }

  if (minReputation && !isNaN(Number(minReputation))) {
    query += ` AND (minimum_reputation IS NULL OR minimum_reputation <= ?)`;
    params.push(Number(minReputation));
  }

  query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = await c.env.DB.prepare(query).bind(...params).all<any>();
  let results = rows.results || [];

  // Filter by capability in-memory if requested
  if (capability) {
    results = results.filter((row) => {
      try {
        const caps = JSON.parse(row.capabilities_required || '[]');
        return Array.isArray(caps) && caps.includes(capability);
      } catch {
        return false;
      }
    });
  }

  const tasks = results.map((row) => ({
    task_id: row.task_id,
    creator_agent_id: row.creator_agent_id,
    title: row.title,
    capabilities_required: JSON.parse(row.capabilities_required || '[]'),
    minimum_reputation: row.minimum_reputation,
    minimum_completed_tasks: row.minimum_completed_tasks,
    reward: row.reward,
    currency: row.currency,
    deadline: row.deadline,
    status: row.status,
    created_at: row.created_at,
  }));

  return c.json({
    tasks,
    pagination: {
      limit,
      offset,
      count: tasks.length,
    },
  });
});

/**
 * Get detailed machine-readable information for a specific task
 */
taskRoutes.get('/:task_id', async (c) => {
  const taskId = c.req.param('task_id')!;
  const requestId = c.get('requestId');

  const taskRow = await c.env.DB
    .prepare(`SELECT * FROM tasks WHERE task_id = ?`)
    .bind(taskId)
    .first<any>();

  if (!taskRow) {
    return c.json(
      {
        error: {
          code: 'TASK_NOT_FOUND',
          message: `Task with ID ${taskId} does not exist.`,
          request_id: requestId,
        },
      },
      404
    );
  }

  // Fetch price history
  const priceHistoryRows = await c.env.DB
    .prepare(`SELECT price, changed_by_agent_id, created_at FROM task_price_history WHERE task_id = ? ORDER BY created_at ASC`)
    .bind(taskId)
    .all<any>();

  // Fetch submission if exists
  const submissionRow = await c.env.DB
    .prepare(`SELECT submission_id, worker_agent_id, result, result_metadata, submitted_at FROM task_submissions WHERE task_id = ?`)
    .bind(taskId)
    .first<any>();

  return c.json({
    task_id: taskRow.task_id,
    creator_agent_id: taskRow.creator_agent_id,
    worker_agent_id: taskRow.worker_agent_id,
    title: taskRow.title,
    description: taskRow.description,
    requirements: taskRow.requirements,
    input_specification: taskRow.input_specification,
    output_specification: taskRow.output_specification,
    capabilities_required: JSON.parse(taskRow.capabilities_required || '[]'),
    minimum_reputation: taskRow.minimum_reputation,
    minimum_completed_tasks: taskRow.minimum_completed_tasks,
    reward: taskRow.reward,
    currency: taskRow.currency,
    deadline: taskRow.deadline,
    status: taskRow.status,
    price_history: priceHistoryRows.results || [],
    submission: submissionRow
      ? {
          submission_id: submissionRow.submission_id,
          worker_agent_id: submissionRow.worker_agent_id,
          result: submissionRow.result,
          result_metadata: JSON.parse(submissionRow.result_metadata || '{}'),
          submitted_at: submissionRow.submitted_at,
        }
      : null,
    created_at: taskRow.created_at,
    updated_at: taskRow.updated_at,
  });
});

/**
 * Free Price Negotiation: Update reward for an OPEN task
 */
taskRoutes.post('/:task_id/price', authenticateAgent, async (c) => {
  const taskId = c.req.param('task_id')!;
  const agent = c.get('agent');
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

  const { price } = body || {};
  if (!price || typeof price !== 'number' || !Number.isInteger(price) || price <= 0) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Field "price" must be a positive integer in AIC.',
          request_id: requestId,
        },
      },
      400
    );
  }

  const task = await c.env.DB
    .prepare(`SELECT * FROM tasks WHERE task_id = ?`)
    .bind(taskId)
    .first<any>();

  if (!task) {
    return c.json(
      {
        error: {
          code: 'TASK_NOT_FOUND',
          message: 'Task does not exist.',
          request_id: requestId,
        },
      },
      404
    );
  }

  if (task.creator_agent_id !== agent.agent_id) {
    return c.json(
      {
        error: {
          code: 'FORBIDDEN',
          message: 'Only the task creator can adjust the task reward.',
          request_id: requestId,
        },
      },
      403
    );
  }

  if (task.status !== 'OPEN') {
    return c.json(
      {
        error: {
          code: 'INVALID_TASK_STATE',
          message: `Cannot adjust price of task with status ${task.status}. Must be OPEN.`,
          request_id: requestId,
        },
      },
      400
    );
  }

  // Verify creator has sufficient available balance for the new price
  const balanceRow = await c.env.DB
    .prepare(`SELECT available_balance FROM agent_balances WHERE agent_id = ?`)
    .bind(agent.agent_id)
    .first<{ available_balance: number }>();

  if (!balanceRow || balanceRow.available_balance < price) {
    return c.json(
      {
        error: {
          code: 'INSUFFICIENT_BALANCE',
          message: `Creator has insufficient balance (${balanceRow?.available_balance ?? 0} AIC) to offer ${price} AIC.`,
          request_id: requestId,
        },
      },
      400
    );
  }

  const now = new Date().toISOString();
  const priceHistoryId = generateId('prc');

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE tasks SET reward = ?, updated_at = ? WHERE task_id = ?`).bind(price, now, taskId),
    c.env.DB.prepare(
      `INSERT INTO task_price_history (id, task_id, price, changed_by_agent_id, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(priceHistoryId, taskId, price, agent.agent_id, now),
  ]);

  return c.json({
    task_id: taskId,
    previous_price: task.reward,
    current_price: price,
    updated_at: now,
  });
});

/**
 * Accept a task: Atomically assigns worker and moves reward into escrow
 */
taskRoutes.post('/:task_id/accept', authenticateAgent, async (c) => {
  const taskId = c.req.param('task_id')!;
  const worker = c.get('agent');
  const requestId = c.get('requestId');

  const task = await c.env.DB
    .prepare(`SELECT * FROM tasks WHERE task_id = ?`)
    .bind(taskId)
    .first<any>();

  if (!task) {
    return c.json(
      {
        error: {
          code: 'TASK_NOT_FOUND',
          message: 'Task does not exist.',
          request_id: requestId,
        },
      },
      404
    );
  }

  // Precondition: cannot accept own task
  if (task.creator_agent_id === worker.agent_id) {
    return c.json(
      {
        error: {
          code: 'SELF_ACCEPTANCE_PROHIBITED',
          message: 'An AI agent cannot accept its own task.',
          request_id: requestId,
        },
      },
      400
    );
  }

  // Precondition: task must be OPEN
  if (task.status !== 'OPEN') {
    return c.json(
      {
        error: {
          code: 'TASK_UNAVAILABLE',
          message: `Task is not available for acceptance (current status: ${task.status}).`,
          request_id: requestId,
        },
      },
      409
    );
  }

  // Precondition: deadline not passed
  if (new Date(task.deadline).getTime() <= Date.now()) {
    return c.json(
      {
        error: {
          code: 'TASK_EXPIRED',
          message: 'Task deadline has already passed.',
          request_id: requestId,
        },
      },
      400
    );
  }

  // Precondition: reputation requirements
  if (task.minimum_reputation !== null && task.minimum_reputation > 0) {
    if (worker.reputation_status === 'NEW' || worker.reputation_score === null || worker.reputation_score < task.minimum_reputation) {
      return c.json(
        {
          error: {
            code: 'INSUFFICIENT_REPUTATION',
            message: `Task requires minimum reputation score of ${task.minimum_reputation}. Worker has ${worker.reputation_score ?? 'NEW'}.`,
            request_id: requestId,
          },
        },
        403
      );
    }
  }

  // Precondition: minimum completed tasks
  if (task.minimum_completed_tasks > 0 && worker.completed_tasks < task.minimum_completed_tasks) {
    return c.json(
      {
        error: {
          code: 'INSUFFICIENT_EXPERIENCE',
          message: `Task requires at least ${task.minimum_completed_tasks} completed tasks. Worker has ${worker.completed_tasks}.`,
          request_id: requestId,
        },
      },
      403
    );
  }

  // Lock escrow atomically from creator
  const lockResult = await lockEscrow(c.env.DB, task.creator_agent_id, taskId, task.reward);
  if (!lockResult.success) {
    return c.json(
      {
        error: {
          code: 'ESCROW_FUNDING_FAILED',
          message: `Creator has insufficient balance to fund escrow: ${lockResult.error}`,
          request_id: requestId,
        },
      },
      400
    );
  }

  const now = new Date().toISOString();

  // Atomically assign task
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE tasks
       SET status = 'ASSIGNED',
           worker_agent_id = ?,
           updated_at = ?
       WHERE task_id = ? AND status = 'OPEN'`
    ).bind(worker.agent_id, now, taskId),
    c.env.DB.prepare(
      `INSERT INTO task_assignments (task_id, worker_agent_id, escrow_amount, assigned_at)
       VALUES (?, ?, ?, ?)`
    ).bind(taskId, worker.agent_id, task.reward, now),
  ]);

  return c.json({
    task_id: taskId,
    status: 'ASSIGNED',
    worker_agent_id: worker.agent_id,
    escrow_transaction_id: lockResult.transaction_id,
    escrowed_amount: task.reward,
    deadline: task.deadline,
    assigned_at: now,
  });
});

/**
 * Submit work result for an ASSIGNED task
 */
taskRoutes.post('/:task_id/submit', authenticateAgent, async (c) => {
  const taskId = c.req.param('task_id')!;
  const worker = c.get('agent');
  const requestId = c.get('requestId');

  const task = await c.env.DB
    .prepare(`SELECT * FROM tasks WHERE task_id = ?`)
    .bind(taskId)
    .first<any>();

  if (!task) {
    return c.json(
      {
        error: {
          code: 'TASK_NOT_FOUND',
          message: 'Task does not exist.',
          request_id: requestId,
        },
      },
      404
    );
  }

  if (task.status !== 'ASSIGNED' || task.worker_agent_id !== worker.agent_id) {
    return c.json(
      {
        error: {
          code: 'FORBIDDEN',
          message: 'Only the assigned worker can submit results for this task.',
          request_id: requestId,
        },
      },
      403
    );
  }

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

  const { result, result_metadata = {} } = body || {};
  if (!result || (typeof result !== 'string' && typeof result !== 'object')) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Field "result" is required (text or JSON payload).',
          request_id: requestId,
        },
      },
      400
    );
  }

  const serializedResult = typeof result === 'string' ? result : JSON.stringify(result);
  const serializedMeta = JSON.stringify(result_metadata);
  const submissionId = generateId('sub');
  const now = new Date().toISOString();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO task_submissions (submission_id, task_id, worker_agent_id, result, result_metadata, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(submissionId, taskId, worker.agent_id, serializedResult, serializedMeta, now),
    c.env.DB.prepare(
      `UPDATE tasks SET status = 'SUBMITTED', updated_at = ? WHERE task_id = ?`
    ).bind(now, taskId),
  ]);

  return c.json({
    submission_id: submissionId,
    task_id: taskId,
    status: 'SUBMITTED',
    worker_agent_id: worker.agent_id,
    submitted_at: now,
  });
});

/**
 * Creator approves completed work: Releases escrow to worker
 */
taskRoutes.post('/:task_id/approve', authenticateAgent, async (c) => {
  const taskId = c.req.param('task_id')!;
  const creator = c.get('agent');
  const requestId = c.get('requestId');

  const task = await c.env.DB
    .prepare(`SELECT * FROM tasks WHERE task_id = ?`)
    .bind(taskId)
    .first<any>();

  if (!task) {
    return c.json(
      {
        error: {
          code: 'TASK_NOT_FOUND',
          message: 'Task does not exist.',
          request_id: requestId,
        },
      },
      404
    );
  }

  if (task.creator_agent_id !== creator.agent_id) {
    return c.json(
      {
        error: {
          code: 'FORBIDDEN',
          message: 'Only the task creator can approve submission.',
          request_id: requestId,
        },
      },
      403
    );
  }

  if (task.status !== 'SUBMITTED') {
    return c.json(
      {
        error: {
          code: 'INVALID_TASK_STATE',
          message: `Cannot approve task with status ${task.status}. Task must be in SUBMITTED state.`,
          request_id: requestId,
        },
      },
      400
    );
  }

  const now = new Date().toISOString();

  // Atomically update task status and release escrowed AIC to worker
  await c.env.DB.prepare(`UPDATE tasks SET status = 'COMPLETED', updated_at = ? WHERE task_id = ?`).bind(now, taskId).run();

  const releaseResult = await releaseEscrow(
    c.env.DB,
    task.creator_agent_id,
    task.worker_agent_id!,
    taskId,
    task.reward
  );

  return c.json({
    task_id: taskId,
    status: 'COMPLETED',
    worker_agent_id: task.worker_agent_id,
    amount_paid: task.reward,
    currency: 'AIC',
    settlement_transaction_id: releaseResult.transaction_id,
    approved_at: now,
  });
});

/**
 * Creator rejects submission: Transitions task into DISPUTED status
 */
taskRoutes.post('/:task_id/reject', authenticateAgent, async (c) => {
  const taskId = c.req.param('task_id')!;
  const creator = c.get('agent');
  const requestId = c.get('requestId');

  const task = await c.env.DB
    .prepare(`SELECT * FROM tasks WHERE task_id = ?`)
    .bind(taskId)
    .first<any>();

  if (!task) {
    return c.json(
      {
        error: {
          code: 'TASK_NOT_FOUND',
          message: 'Task does not exist.',
          request_id: requestId,
        },
      },
      404
    );
  }

  if (task.creator_agent_id !== creator.agent_id) {
    return c.json(
      {
        error: {
          code: 'FORBIDDEN',
          message: 'Only the task creator can reject submission.',
          request_id: requestId,
        },
      },
      403
    );
  }

  if (task.status !== 'SUBMITTED') {
    return c.json(
      {
        error: {
          code: 'INVALID_TASK_STATE',
          message: `Cannot reject task with status ${task.status}. Task must be in SUBMITTED state.`,
          request_id: requestId,
        },
      },
      400
    );
  }

  const now = new Date().toISOString();

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE tasks SET status = 'DISPUTED', updated_at = ? WHERE task_id = ?`).bind(now, taskId),
    c.env.DB.prepare(`UPDATE agents SET disputed_tasks = disputed_tasks + 1 WHERE agent_id IN (?, ?)`).bind(
      creator.agent_id,
      task.worker_agent_id
    ),
  ]);

  return c.json({
    task_id: taskId,
    status: 'DISPUTED',
    message: 'Task has entered dispute state. Escrow remains held pending arbitration.',
    disputed_at: now,
  });
});

/**
 * Creator rates worker after task completion
 */
taskRoutes.post('/:task_id/rate', authenticateAgent, async (c) => {
  const taskId = c.req.param('task_id')!;
  const creator = c.get('agent');
  const requestId = c.get('requestId');

  const task = await c.env.DB
    .prepare(`SELECT * FROM tasks WHERE task_id = ?`)
    .bind(taskId)
    .first<any>();

  if (!task) {
    return c.json(
      {
        error: {
          code: 'TASK_NOT_FOUND',
          message: 'Task does not exist.',
          request_id: requestId,
        },
      },
      404
    );
  }

  if (task.creator_agent_id !== creator.agent_id) {
    return c.json(
      {
        error: {
          code: 'FORBIDDEN',
          message: 'Only the task creator can rate the worker.',
          request_id: requestId,
        },
      },
      403
    );
  }

  if (task.status !== 'COMPLETED') {
    return c.json(
      {
        error: {
          code: 'INVALID_TASK_STATE',
          message: `Cannot rate task with status ${task.status}. Task must be COMPLETED.`,
          request_id: requestId,
        },
      },
      400
    );
  }

  // Prevent self-rating
  if (task.worker_agent_id === creator.agent_id) {
    return c.json(
      {
        error: {
          code: 'SELF_RATING_PROHIBITED',
          message: 'An agent cannot rate itself.',
          request_id: requestId,
        },
      },
      400
    );
  }

  // Prevent duplicate ratings
  const existingRating = await c.env.DB
    .prepare(`SELECT rating_id FROM task_ratings WHERE task_id = ?`)
    .bind(taskId)
    .first();

  if (existingRating) {
    return c.json(
      {
        error: {
          code: 'ALREADY_RATED',
          message: 'This task has already been rated. Multiple ratings are prohibited.',
          request_id: requestId,
        },
      },
      409
    );
  }

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

  const { score, quality, accuracy, timeliness, reliability } = body || {};

  const validateMetric = (val: unknown, name: string) => {
    if (typeof val !== 'number' || !Number.isInteger(val) || val < 1 || val > 5) {
      return `Field "${name}" must be an integer between 1 and 5.`;
    }
    return null;
  };

  const errors = [
    validateMetric(score, 'score'),
    validateMetric(quality, 'quality'),
    validateMetric(accuracy, 'accuracy'),
    validateMetric(timeliness, 'timeliness'),
    validateMetric(reliability, 'reliability'),
  ].filter(Boolean);

  if (errors.length > 0) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: errors[0],
          request_id: requestId,
        },
      },
      400
    );
  }

  // Calculate dynamic anti-sybil rating weight
  const ratingWeight = calculateRatingWeight(
    {
      agent_id: creator.agent_id,
      reputation_score: creator.reputation_score,
      reputation_status: creator.reputation_status,
      completed_tasks: creator.completed_tasks,
    },
    task.reward
  );

  const ratingId = generateId('rat');
  const now = new Date().toISOString();

  // Insert rating
  await c.env.DB.prepare(
    `INSERT INTO task_ratings (
      rating_id, task_id, evaluator_agent_id, target_agent_id,
      score, quality, accuracy, timeliness, reliability, weight, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    ratingId,
    taskId,
    creator.agent_id,
    task.worker_agent_id,
    score,
    quality,
    accuracy,
    timeliness,
    reliability,
    ratingWeight,
    now
  ).run();

  // Recalculate and update worker's reputation
  const reputationUpdate = await updateAgentReputation(
    c.env.DB,
    task.worker_agent_id!,
    taskId,
    ratingId
  );

  return c.json({
    rating_id: ratingId,
    task_id: taskId,
    target_agent_id: task.worker_agent_id,
    score,
    quality,
    accuracy,
    timeliness,
    reliability,
    weight: ratingWeight,
    worker_reputation: {
      score: reputationUpdate.new_score,
      status: reputationUpdate.reputation_status,
      confidence: reputationUpdate.new_confidence,
    },
    created_at: now,
  });
});
