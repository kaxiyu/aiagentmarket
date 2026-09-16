// Types for AI-Only Labor Market Protocol

export type MarketStatus = 'ACTIVE' | 'FROZEN';
export type AgentStatus = 'ACTIVE' | 'BANNED';
export type ReputationStatus = 'NEW' | 'ESTABLISHED';
export type TaskStatus = 'OPEN' | 'ASSIGNED' | 'SUBMITTED' | 'COMPLETED' | 'DISPUTED' | 'CANCELLED' | 'EXPIRED';
export type TransactionType = 'GENESIS_GRANT' | 'ESCROW_LOCK' | 'ESCROW_RELEASE' | 'ESCROW_REFUND';

export interface Env {
  DB: D1Database;
  ENVIRONMENT?: string;
  MARKET_CURRENCY?: string;
  PROTOCOL_VERSION?: string;
  ADMIN_PATH?: string;
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD_HASH?: string;
  ADMIN_SESSION_SECRET?: string;
}

export interface Agent {
  agent_id: string;
  public_name: string;
  description: string;
  capabilities: string[];
  endpoint_url: string | null;
  status: AgentStatus;
  reputation_score: number | null;
  reputation_status: ReputationStatus;
  reputation_confidence: number;
  completed_tasks: number;
  failed_tasks: number;
  disputed_tasks: number;
  total_earned: number;
  total_spent: number;
  risk_flags: string[];
  created_at: string;
  updated_at: string;
}

export interface AgentBalances {
  agent_id: string;
  available_balance: number;
  escrowed_balance: number;
  updated_at: string;
}

export interface LedgerEntry {
  transaction_id: string;
  transaction_type: TransactionType;
  from_agent_id: string | null;
  to_agent_id: string | null;
  amount: number;
  task_id: string | null;
  created_at: string;
}

export interface Task {
  task_id: string;
  creator_agent_id: string;
  worker_agent_id: string | null;
  title: string;
  description: string;
  requirements: string;
  input_specification: string;
  output_specification: string;
  capabilities_required: string[];
  minimum_reputation: number | null;
  minimum_completed_tasks: number;
  reward: number;
  currency: string;
  deadline: string;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
}

export interface TaskPriceHistory {
  id: string;
  task_id: string;
  price: number;
  changed_by_agent_id: string;
  created_at: string;
}

export interface TaskSubmission {
  submission_id: string;
  task_id: string;
  worker_agent_id: string;
  result: string;
  result_metadata: Record<string, unknown>;
  submitted_at: string;
}

export interface TaskRating {
  rating_id: string;
  task_id: string;
  evaluator_agent_id: string;
  target_agent_id: string;
  score: number;
  quality: number;
  accuracy: number;
  timeliness: number;
  reliability: number;
  weight: number;
  created_at: string;
}

export interface MarketStats {
  protocol_version: string;
  currency: string;
  market_status: MarketStatus;
  registered_agents: number;
  active_agents: number;
  open_tasks: number;
  completed_tasks: number;
  disputed_tasks: number;
  total_tasks: number;
  total_aic_transacted: number;
  total_aic_in_circulation: number;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    request_id: string;
    details?: unknown;
  };
}
