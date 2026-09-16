// Reputation Engine with Weighted Anti-Sybil Foundations

import { generateId } from './crypto';

export interface RatingInput {
  score: number; // 1-5
  quality: number; // 1-5
  accuracy: number; // 1-5
  timeliness: number; // 1-5
  reliability: number; // 1-5
}

export interface EvaluatorContext {
  agent_id: string;
  reputation_score: number | null;
  reputation_status: 'NEW' | 'ESTABLISHED';
  completed_tasks: number;
}

/**
 * Calculates dynamic weight for a rating based on:
 * 1. Evaluator reputation score & experience
 * 2. Economic value of the completed task
 */
export function calculateRatingWeight(
  evaluator: EvaluatorContext,
  taskReward: number
): number {
  // 1. Evaluator reputation factor (0.2 for brand new evaluators up to 1.0)
  let evaluatorRepFactor = 0.25;
  if (evaluator.reputation_status === 'ESTABLISHED' && evaluator.reputation_score !== null) {
    evaluatorRepFactor = 0.5 + 0.5 * evaluator.reputation_score;
  }

  // 2. Evaluator task history experience (scales up with completed tasks, caps at 1.0)
  const evaluatorExperienceFactor = Math.min(1.0, 0.2 + 0.08 * evaluator.completed_tasks);

  // 3. Task economic value weight (micro-transactions carry low weight to deter Sybil farming)
  // 10 AIC -> ~0.2, 1,000 AIC -> ~0.6, 100,000 AIC -> 1.0
  const normalizedReward = Math.max(1, taskReward);
  const taskValueWeight = Math.min(1.0, Math.max(0.15, Math.log10(normalizedReward) / 5.0));

  const totalWeight = evaluatorRepFactor * evaluatorExperienceFactor * taskValueWeight;
  return Math.max(0.05, Math.round(totalWeight * 1000) / 1000);
}

/**
 * Normalizes 1-5 rating components into a single composite score between 0.0 and 1.0
 */
export function computeCompositeRatingScore(input: RatingInput): number {
  // Weighted components: score (primary) + quality + accuracy + timeliness + reliability
  const sum = input.score * 2 + input.quality + input.accuracy + input.timeliness + input.reliability;
  const maxPossible = 5 * 2 + 5 + 5 + 5 + 5; // 30
  return Math.min(1.0, Math.max(0.0, sum / maxPossible));
}

/**
 * Recalculates and persists target agent's reputation score and confidence
 */
export async function updateAgentReputation(
  db: D1Database,
  targetAgentId: string,
  taskId: string,
  ratingId: string
): Promise<{
  new_score: number;
  new_confidence: number;
  reputation_status: 'NEW' | 'ESTABLISHED';
}> {
  // Fetch existing agent reputation data
  const currentAgent = await db
    .prepare(`SELECT reputation_score, reputation_confidence, reputation_status, risk_flags FROM agents WHERE agent_id = ?`)
    .bind(targetAgentId)
    .first<{
      reputation_score: number | null;
      reputation_confidence: number;
      reputation_status: 'NEW' | 'ESTABLISHED';
      risk_flags: string;
    }>();

  if (!currentAgent) {
    throw new Error('Target agent not found');
  }

  // Fetch all ratings for target agent
  const ratingsResult = await db
    .prepare(
      `SELECT score, quality, accuracy, timeliness, reliability, weight, evaluator_agent_id
       FROM task_ratings
       WHERE target_agent_id = ?`
    )
    .bind(targetAgentId)
    .all<{
      score: number;
      quality: number;
      accuracy: number;
      timeliness: number;
      reliability: number;
      weight: number;
      evaluator_agent_id: string;
    }>();

  const ratings = ratingsResult.results ?? [];
  const totalRatings = ratings.length;

  if (totalRatings === 0) {
    return {
      new_score: currentAgent.reputation_score ?? 0,
      new_confidence: 0,
      reputation_status: 'NEW',
    };
  }

  // Calculate weighted score: SUM(composite * weight) / SUM(weight)
  let weightedSum = 0;
  let totalWeight = 0;
  const evaluatorSet = new Set<string>();

  for (const r of ratings) {
    const composite = computeCompositeRatingScore({
      score: r.score,
      quality: r.quality,
      accuracy: r.accuracy,
      timeliness: r.timeliness,
      reliability: r.reliability,
    });
    weightedSum += composite * r.weight;
    totalWeight += r.weight;
    evaluatorSet.add(r.evaluator_agent_id);
  }

  const newScore = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 1000) / 1000 : 0.5;

  // Confidence is calculated from number of ratings and evaluator diversity
  // C = (1 - e^(-0.3 * N)) * (unique_evaluators / N)^0.5
  const sampleFactor = 1 - Math.exp(-0.35 * totalRatings);
  const diversityFactor = Math.sqrt(evaluatorSet.size / totalRatings);
  const newConfidence = Math.min(1.0, Math.round(sampleFactor * diversityFactor * 1000) / 1000);

  const now = new Date().toISOString();
  const eventId = generateId('rev');

  await db.batch([
    // Update agent
    db
      .prepare(
        `UPDATE agents
         SET reputation_score = ?,
             reputation_status = 'ESTABLISHED',
             reputation_confidence = ?,
             updated_at = ?
         WHERE agent_id = ?`
      )
      .bind(newScore, newConfidence, now, targetAgentId),
    // Record reputation event
    db
      .prepare(
        `INSERT INTO agent_reputation_events
         (event_id, agent_id, task_id, rating_id, previous_score, new_score, previous_confidence, new_confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        eventId,
        targetAgentId,
        taskId,
        ratingId,
        currentAgent.reputation_score,
        newScore,
        currentAgent.reputation_confidence,
        newConfidence,
        now
      ),
  ]);

  return {
    new_score: newScore,
    new_confidence: newConfidence,
    reputation_status: 'ESTABLISHED',
  };
}
