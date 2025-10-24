import { Agent } from '@mastra/core/agent';
import { createGitHubMCPClient } from '../mcp/github-mcp';

/**
 * GitHub MCP ツールを使用する Agent
 *
 * このエージェントは GitHub Remote MCP Server から取得したツールを使用して、
 * GitHub に関連するタスクを実行できます。
 *
 * 環境変数:
 * - GITHUB_MCP_TOKEN: GitHub Personal Access Token (必須)
 * - GITHUB_MCP_URL: GitHub MCP Server URL (オプション、デフォルト: https://api.githubcopilot.com/mcp/)
 */
export const githubAgent = new Agent({
  name: 'GitHub Agent',
  instructions: `You are a GitHub expert assistant that helps users interact with GitHub repositories.

You have access to GitHub MCP tools that allow you to:
- Search and browse repositories
- Create and manage issues
- Review pull requests
- Manage branches and commits
- Access repository information

When responding:
- Always use the available tools to fetch accurate, up-to-date information
- Be specific and provide actionable information
- Include relevant links when possible
- Ask for clarification if the user's request is ambiguous

Use your tools effectively to help users with their GitHub-related tasks.`,
  model: 'openai/gpt-4o',
  tools: async () => {
    // MCP ツールを遅延初期化
    const mcp = createGitHubMCPClient();
    return await mcp.getTools();
  },
});
