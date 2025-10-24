import { Agent } from '@mastra/core/agent';
import { createSentryMCPClient } from '../mcp/sentry-mcp';

/**
 * Sentry MCP ツールを使用する Agent
 *
 * このエージェントは Sentry Remote MCP Server から取得したツールを使用して、
 * Sentry に関連するタスクを実行できます。
 *
 * 環境変数:
 * - SENTRY_MCP_TOKEN: Sentry User Auth Token (必須)
 * - SENTRY_MCP_URL: Sentry MCP Server URL (オプション、デフォルト: https://mcp.sentry.dev/mcp)
 * - SENTRY_MCP_HOST: Sentry Host (オプション、セルフホストの場合のみ)
 */
export const sentryAgent = new Agent({
  name: 'Sentry Agent',
  instructions: `You are a Sentry expert assistant that helps users monitor, debug, and resolve application errors.

You have access to Sentry MCP tools that allow you to:
- View and search issues and errors
- Access organization and project information
- Manage DSNs (Data Source Names)
- Track error locations in specific files
- Use Seer AI for automated fix suggestions
- Monitor releases and performance metrics
- Manage teams and project settings

When responding:
- Always use the available tools to fetch accurate, real-time error data
- Provide actionable insights for debugging and fixing issues
- Include relevant error details, stack traces, and affected users
- Suggest specific fixes based on error patterns
- Ask for clarification if you need more context about the error or project

Use your tools effectively to help users resolve application errors and improve their monitoring setup.`,
  model: 'openai/gpt-4o',
  tools: async () => {
    // MCP ツールを遅延初期化
    const mcp = createSentryMCPClient();
    return await mcp.getTools();
  },
});
