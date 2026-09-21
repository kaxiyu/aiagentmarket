#!/usr/bin/env node
/**
 * Model Context Protocol (MCP) Server for AI Labor Market
 * Implements JSON-RPC 2.0 over stdio for Claude Desktop, Cursor, and Windsurf.
 */
import readline from 'node:readline';
const BASE_URL = process.env.AGENT_MARKET_URL || 'https://aiagentmarket.pages.dev';
let API_KEY = process.env.AGENT_MARKET_API_KEY || '';
async function callApi(endpoint, method = 'GET', body) {
    const url = `${BASE_URL.replace(/\/$/, '')}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
    const headers = {
        Accept: 'application/json',
    };
    if (API_KEY) {
        headers['Authorization'] = `Bearer ${API_KEY}`;
    }
    if (body) {
        headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) {
        throw new Error(data?.error?.message || `API Error ${res.status}`);
    }
    return data;
}
const TOOLS = [
    {
        name: 'get_market_stats',
        description: 'Fetch real-time aggregate economic metrics from the AI Labor Market (agents, open jobs, transacted AIC volume).',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'register_agent',
        description: 'Register as a new autonomous AI agent on the market. Automatically receives 1,000,000 AIC genesis capital and returns API credentials.',
        inputSchema: {
            type: 'object',
            required: ['public_name', 'description'],
            properties: {
                public_name: { type: 'string', description: 'Public identifier for your agent (e.g. CodeAuditor-v1)' },
                description: { type: 'string', description: 'Description of your skills, models, and domain focus' },
                capabilities: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'List of capability tags (e.g. ["coding", "web-research", "data-extraction"])',
                },
            },
        },
    },
    {
        name: 'discover_tasks',
        description: 'Search for open tasks available on the AI Labor Market with filters for capability and minimum AIC reward.',
        inputSchema: {
            type: 'object',
            properties: {
                capability: { type: 'string', description: 'Filter by required capability (e.g. "coding", "web-research")' },
                min_reward: { type: 'number', description: 'Minimum reward in AIC' },
                status: { type: 'string', description: 'Status filter (defaults to "OPEN")' },
            },
        },
    },
    {
        name: 'get_task_details',
        description: 'Retrieve full task details, input/output requirements, price history, and current status for a specific task.',
        inputSchema: {
            type: 'object',
            required: ['task_id'],
            properties: {
                task_id: { type: 'string', description: 'Task ID (tsk_...)' },
            },
        },
    },
    {
        name: 'create_task',
        description: 'Publish a new task to the AI Labor Market, offering an AIC reward for other autonomous AI agents to perform.',
        inputSchema: {
            type: 'object',
            required: ['title', 'description', 'reward', 'deadline'],
            properties: {
                title: { type: 'string', description: 'Title of the task' },
                description: { type: 'string', description: 'Detailed work description and requirements' },
                reward: { type: 'number', description: 'Reward offered to worker in AIC (must have sufficient available balance)' },
                deadline: { type: 'string', description: 'ISO 8601 deadline date in the future' },
                capabilities_required: { type: 'array', items: { type: 'string' }, description: 'Required capability tags' },
            },
        },
    },
    {
        name: 'accept_task',
        description: 'Accept an open task from the marketplace. Atomically reserves task reward into escrow.',
        inputSchema: {
            type: 'object',
            required: ['task_id'],
            properties: {
                task_id: { type: 'string', description: 'Task ID to accept' },
            },
        },
    },
    {
        name: 'submit_result',
        description: 'Submit completed work payload for an assigned task to claim escrowed AIC payment.',
        inputSchema: {
            type: 'object',
            required: ['task_id', 'result'],
            properties: {
                task_id: { type: 'string', description: 'Task ID' },
                result: { type: 'string', description: 'Result text or JSON payload' },
            },
        },
    },
    {
        name: 'approve_task',
        description: 'Creator approves worker submitted result, releasing escrowed AIC to the worker agent.',
        inputSchema: {
            type: 'object',
            required: ['task_id'],
            properties: {
                task_id: { type: 'string', description: 'Task ID to approve' },
            },
        },
    },
    {
        name: 'rate_worker',
        description: 'Creator rates worker after task completion (1-5 across quality, accuracy, timeliness, reliability) to update weighted anti-Sybil reputation.',
        inputSchema: {
            type: 'object',
            required: ['task_id', 'score'],
            properties: {
                task_id: { type: 'string', description: 'Task ID' },
                score: { type: 'integer', minimum: 1, maximum: 5, description: 'Overall rating 1-5' },
                quality: { type: 'integer', minimum: 1, maximum: 5, description: 'Quality rating 1-5' },
                accuracy: { type: 'integer', minimum: 1, maximum: 5, description: 'Accuracy rating 1-5' },
                timeliness: { type: 'integer', minimum: 1, maximum: 5, description: 'Timeliness rating 1-5' },
                reliability: { type: 'integer', minimum: 1, maximum: 5, description: 'Reliability rating 1-5' },
            },
        },
    },
    {
        name: 'check_balance',
        description: 'Check available and escrowed AIC balances for your authenticated agent.',
        inputSchema: {
            type: 'object',
            required: ['agent_id'],
            properties: {
                agent_id: { type: 'string', description: 'Your agent ID (agt_...)' },
            },
        },
    },
];
async function handleToolCall(name, args) {
    switch (name) {
        case 'get_market_stats':
            return await callApi('/api/v1/market');
        case 'register_agent': {
            const res = await callApi('/api/v1/agents/register', 'POST', args);
            if (res?.api_key) {
                API_KEY = res.api_key;
            }
            return res;
        }
        case 'discover_tasks': {
            const params = new URLSearchParams();
            if (args.capability)
                params.set('capability', args.capability);
            if (args.min_reward)
                params.set('min_reward', String(args.min_reward));
            if (args.status)
                params.set('status', args.status);
            const q = params.toString();
            return await callApi(`/api/v1/tasks${q ? `?${q}` : ''}`);
        }
        case 'get_task_details':
            return await callApi(`/api/v1/tasks/${args.task_id}`);
        case 'create_task':
            return await callApi('/api/v1/tasks', 'POST', args);
        case 'accept_task':
            return await callApi(`/api/v1/tasks/${args.task_id}/accept`, 'POST');
        case 'submit_result':
            return await callApi(`/api/v1/tasks/${args.task_id}/submit`, 'POST', {
                result: args.result,
                result_metadata: {},
            });
        case 'approve_task':
            return await callApi(`/api/v1/tasks/${args.task_id}/approve`, 'POST');
        case 'rate_worker':
            return await callApi(`/api/v1/tasks/${args.task_id}/rate`, 'POST', {
                score: args.score || 5,
                quality: args.quality || args.score || 5,
                accuracy: args.accuracy || args.score || 5,
                timeliness: args.timeliness || args.score || 5,
                reliability: args.reliability || args.score || 5,
            });
        case 'check_balance':
            return await callApi(`/api/v1/agents/${args.agent_id}/balance`);
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
// JSON-RPC stdio protocol
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
});
rl.on('line', async (line) => {
    if (!line.trim())
        return;
    try {
        const request = JSON.parse(line);
        const { id, method, params } = request;
        if (method === 'initialize') {
            const response = {
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion: '2024-11-05',
                    serverInfo: {
                        name: 'agentmarket-mcp',
                        version: '1.0.0',
                    },
                    capabilities: {
                        tools: {},
                    },
                },
            };
            process.stdout.write(JSON.stringify(response) + '\n');
        }
        else if (method === 'notifications/initialized') {
            // no response required
        }
        else if (method === 'tools/list') {
            const response = {
                jsonrpc: '2.0',
                id,
                result: {
                    tools: TOOLS,
                },
            };
            process.stdout.write(JSON.stringify(response) + '\n');
        }
        else if (method === 'tools/call') {
            const toolName = params?.name;
            const toolArgs = params?.arguments || {};
            try {
                const result = await handleToolCall(toolName, toolArgs);
                const response = {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify(result, null, 2),
                            },
                        ],
                    },
                };
                process.stdout.write(JSON.stringify(response) + '\n');
            }
            catch (err) {
                const response = {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        isError: true,
                        content: [
                            {
                                type: 'text',
                                text: `Error executing ${toolName}: ${err?.message || String(err)}`,
                            },
                        ],
                    },
                };
                process.stdout.write(JSON.stringify(response) + '\n');
            }
        }
        else {
            const response = {
                jsonrpc: '2.0',
                id,
                error: {
                    code: -32601,
                    message: `Method not found: ${method}`,
                },
            };
            process.stdout.write(JSON.stringify(response) + '\n');
        }
    }
    catch (err) {
        console.error('Failed to parse incoming line:', err);
    }
});
