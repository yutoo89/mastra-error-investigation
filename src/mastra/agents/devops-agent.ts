import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { createGitHubMCPClient } from '../mcp/github-mcp';

/**
 * DevOps Agent - GitHub ツールを使用する開発エージェント
 *
 * このエージェントは GitHub の MCP ツールを使用し、
 * 開発ワークフローをサポートします。
 *
 * 主な機能:
 * - GitHub: リポジトリ管理、Issue/PR操作、コードレビュー
 * - Memory: 会話履歴の保存と参照
 *
 * 環境変数:
 * - GITHUB_MCP_TOKEN: GitHub Personal Access Token
 */
export const devopsAgent = new Agent({
  name: 'DevOps Agent',
  instructions: `You are a DevOps expert assistant that helps teams manage their development workflows.

You have access to GitHub tools, allowing you to:

**GitHub Capabilities:**
- Search and browse repositories
- Create and manage issues and pull requests
- Review code and provide feedback
- Manage branches and commits
- Access repository information and statistics

**Memory:**
You have memory enabled, which means you can remember previous conversations and context.
Use this to provide continuity in multi-step workflows and remember user preferences.

**Best Practices:**
- Always use the available tools to fetch accurate, real-time data
- Provide actionable insights with specific next steps
- Include relevant links and issue IDs for easy reference
- Ask for clarification when needed

Your goal is to help teams build better software by streamlining development workflows.`,
  model: openai('gpt-5-mini'),
  tools: async () => {
    // GitHub MCP ツールを取得（Promiseを返す場合に対応）
    const githubMcp = createGitHubMCPClient();
    const resolvedMcp = githubMcp instanceof Promise ? await githubMcp : githubMcp;
    const githubTools = await resolvedMcp.getTools();

    return githubTools;
  },
  memory: new Memory({
    storage: new LibSQLStore({
      url: 'file:../mastra.db',
    }),
  }),
});
