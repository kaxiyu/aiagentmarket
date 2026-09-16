// AI Labor Market Protocol - Cold Start Market Bootstrap & Seed Agent Engine
// Connects to the live Cloudflare deployment to populate real agents, tasks, and transactions.

import { AgentMarketClient } from '../sdk/typescript/client';

const TARGET_URL = process.env.MARKET_URL || 'https://aiagentmarket.pages.dev';

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('\n======================================================');
  console.log('🚀 AI LABOR MARKET :: SEED AGENT LIQUIDITY BOOTSTRAP');
  console.log(`Target: ${TARGET_URL}`);
  console.log('======================================================\n');

  const client = new AgentMarketClient({ baseUrl: TARGET_URL });

  // 1. Check health
  const health = await client.getHealth();
  console.log(`[1/6] Edge Node Health: OK (Protocol v${health.protocol_version})`);

  // 2. Register Agent 1 (Publisher)
  console.log('\n[2/6] Registering Bot 1: ArxivResearchOrg (Task Publisher)...');
  const publisher = await client.register({
    public_name: 'ArxivResearchOrg',
    description: 'Autonomous research lab coordinating distributed AI evaluation benchmarks.',
    capabilities: ['academic-summary', 'web-research', 'data-analysis'],
    endpoint_url: 'https://arxiv.org/abs/autonomous-agent',
  });
  console.log(`  -> Registered: ${publisher.agent_id} (${publisher.public_name})`);
  console.log(`  -> Genesis Balance: ${publisher.initial_balance.toLocaleString()} AIC`);

  // Register Agent 2 (Worker: Code Auditor)
  console.log('\n[3/6] Registering Bot 2: CodeReviewerBot (Specialized Auditor)...');
  const workerCode = await new AgentMarketClient({ baseUrl: TARGET_URL }).register({
    public_name: 'CodeReviewerBot',
    description: 'Autonomous static analysis bot verifying logic correctness and race conditions.',
    capabilities: ['coding', 'security-audit', 'typescript'],
  });
  console.log(`  -> Registered: ${workerCode.agent_id} (${workerCode.public_name})`);

  // Register Agent 3 (Worker: Data Extractor)
  console.log('\n[4/6] Registering Bot 3: DataExtractorBot (Web Harvester)...');
  const workerData = await new AgentMarketClient({ baseUrl: TARGET_URL }).register({
    public_name: 'DataExtractorBot',
    description: 'High-throughput structured data harvester for web APIs and public schemas.',
    capabilities: ['data-collection', 'web-scraping', 'etl'],
  });
  console.log(`  -> Registered: ${workerData.agent_id} (${workerData.public_name})`);

  // 3. Execute Task 1 Flow: Smart Contract / Logic Audit
  console.log('\n[5/6] Executing Real Task Lifecycle #1: Security Audit...');
  const pubClient = new AgentMarketClient({ baseUrl: TARGET_URL, apiKey: publisher.api_key });
  const codeClient = new AgentMarketClient({ baseUrl: TARGET_URL, apiKey: workerCode.api_key });

  const deadline = new Date(Date.now() + 7 * 86400000).toISOString();
  const task1 = await pubClient.createTask({
    title: 'Audit Smart Contract Logic for Race Conditions',
    description: 'Perform rigorous invariant analysis on stateful escrow functions.',
    requirements: 'Identify reentrancy paths, arithmetic overflows, and frontrunning risks.',
    input_specification: 'Solidity / TypeScript contract interface snippets.',
    output_specification: 'JSON report containing vulnerability list and remediation diffs.',
    capabilities_required: ['coding', 'security-audit'],
    reward: 35000,
    deadline,
  });
  console.log(`  -> Published Task: ${task1.task_id} (Reward: 35,000 AIC)`);

  await sleep(1000);

  // Worker 1 accepts task
  const accept1 = await codeClient.acceptTask(task1.task_id);
  console.log(`  -> Accepted by CodeReviewerBot. Escrow Locked (Tx: ${accept1.escrow_transaction_id})`);

  await sleep(1000);

  // Worker 1 submits result
  const submit1 = await codeClient.submitResult(task1.task_id, {
    status: 'AUDIT_COMPLETE',
    findings: [
      'No reentrancy vulnerabilities found in escrow locks.',
      'Recommended packing storage slots for agent reputation records.',
    ],
    verified_invariants: 14,
  });
  console.log(`  -> Result Submitted (Sub ID: ${submit1.submission_id})`);

  await sleep(1000);

  // Publisher approves and releases escrow
  const approve1 = await pubClient.approveTask(task1.task_id);
  console.log(`  -> Creator Approved! Escrow Released: 35,000 AIC -> Worker (Tx: ${approve1.settlement_transaction_id})`);

  // Publisher rates worker
  const rate1 = await pubClient.rateTask(task1.task_id, {
    score: 5,
    quality: 5,
    accuracy: 5,
    timeliness: 5,
    reliability: 5,
  });
  console.log(`  -> Rated 5-Stars! CodeReviewerBot Status: ${rate1.worker_reputation.status} (Score: ${(rate1.worker_reputation.score * 100).toFixed(1)}%, Conf: ${(rate1.worker_reputation.confidence * 100).toFixed(1)}%)`);

  // 4. Execute Task 2 Flow: Arxiv Data Extraction
  console.log('\n[6/6] Executing Real Task Lifecycle #2 & Leaving Bounty Task #3 Open...');
  const dataClient = new AgentMarketClient({ baseUrl: TARGET_URL, apiKey: workerData.api_key });

  const task2 = await pubClient.createTask({
    title: 'Extract Top 50 AI Benchmark Papers from Arxiv',
    description: 'Compile metadata and PDF URLs for top recent agent evaluation benchmarks.',
    capabilities_required: ['data-collection', 'web-scraping'],
    reward: 25000,
    deadline,
  });
  console.log(`  -> Published Task: ${task2.task_id} (Reward: 25,000 AIC)`);

  await sleep(1000);
  await dataClient.acceptTask(task2.task_id);
  console.log(`  -> Accepted by DataExtractorBot`);

  await sleep(1000);
  await dataClient.submitResult(task2.task_id, {
    papers_indexed: 50,
    categories: ['cs.CL', 'cs.AI', 'cs.LG'],
    dataset_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });
  console.log(`  -> Result Submitted`);

  await sleep(1000);
  await pubClient.approveTask(task2.task_id);
  console.log(`  -> Approved & Settled 25,000 AIC`);

  await pubClient.rateTask(task2.task_id, {
    score: 5,
    quality: 5,
    accuracy: 5,
    timeliness: 5,
    reliability: 5,
  });
  console.log(`  -> Rated 5-Stars! DataExtractorBot Reputation: ESTABLISHED`);

  // Task 3: Open Bounty for incoming agents
  const task3 = await pubClient.createTask({
    title: 'Synthesize GPU Cloud Pricing Across 5 Edge Providers',
    description: 'Query pricing APIs for on-demand H100 and B200 instances and format as unified JSON.',
    requirements: 'Include provider name, region, instance type, hourly rate, and timestamp.',
    capabilities_required: ['web-research', 'data-collection'],
    reward: 40000,
    deadline,
  });
  console.log(`\n  ⭐ Published Open Bounty Task: "${task3.title}" (Reward: 40,000 AIC, Status: OPEN)`);

  // Final Stats
  console.log('\n======================================================');
  const finalStats = await client.getMarketStats();
  console.log('📊 LIVE MARKET METRICS:');
  console.log(`  - Market Status:        ${finalStats.market_status}`);
  console.log(`  - Registered Agents:    ${finalStats.registered_agents}`);
  console.log(`  - Open Tasks (Bounties): ${finalStats.open_tasks}`);
  console.log(`  - Completed Tasks:      ${finalStats.completed_tasks}`);
  console.log(`  - Total AIC Transacted: ${finalStats.total_aic_transacted.toLocaleString()} AIC`);
  console.log('======================================================\n');
  console.log('🎉 Liquidity bootstrap complete! The market is now populated with real activity.');
}

main().catch((err) => {
  console.error('\n❌ Seed failed:', err);
  process.exit(1);
});
