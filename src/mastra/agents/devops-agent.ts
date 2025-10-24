import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { createGitHubMCPClient } from '../mcp/github-mcp';
import { createSentryMCPClient } from '../mcp/sentry-mcp';

/**
 * DevOps Agent - GitHub と Sentry の両方のツールを使用する統合エージェント
 *
 * このエージェントは GitHub と Sentry の MCP ツールを組み合わせて使用し、
 * 開発・運用の両面からサポートを提供します。
 *
 * 主な機能:
 * - GitHub: リポジトリ管理、Issue/PR操作、コードレビュー
 * - Sentry: エラー監視、デバッグ、パフォーマンス追跡
 * - Memory: 会話履歴の保存と参照
 *
 * 環境変数:
 * - GITHUB_MCP_TOKEN: GitHub Personal Access Token
 * - SENTRY_MCP_TOKEN: Sentry User Auth Token
 * - SENTRY_MCP_URL: Sentry 組織 URL
 */
export const devopsAgent = new Agent({
  name: 'DevOps Agent',
  instructions: `You are a DevOps expert assistant that helps teams manage their development and operations workflows.

You have access to both GitHub and Sentry tools, allowing you to:

**GitHub Capabilities:**
- Search and browse repositories
- Create and manage issues and pull requests
- Review code and provide feedback
- Manage branches and commits
- Access repository information and statistics

**Sentry Capabilities:**
- Monitor and analyze application errors
- Search and filter issues by severity, frequency, or timeframe
- Track error locations in source code
- Access stack traces and debugging information
- Monitor releases and performance metrics
- Use AI-powered fix suggestions (Seer)

**Integration Workflows:**
- Link Sentry errors to GitHub issues
- Create GitHub issues from Sentry errors
- Track error resolution through GitHub PRs
- Monitor deployment health across both platforms

**Memory:**
You have memory enabled, which means you can remember previous conversations and context.
Use this to provide continuity in multi-step workflows and remember user preferences.

**Best Practices:**
- Always use the available tools to fetch accurate, real-time data
- Provide actionable insights with specific next steps
- Connect related information across GitHub and Sentry when relevant
- Include relevant links and error IDs for easy reference
- Ask for clarification when needed

Your goal is to help teams build better software by connecting development activity with production monitoring.`,
  model: 'openai/gpt-5',
  tools: async () => {
    // GitHub と Sentry の両方の MCP ツールを取得
    const githubMcp = createGitHubMCPClient();
    const sentryMcp = createSentryMCPClient();

    const [githubTools, sentryTools] = await Promise.all([
      githubMcp.getTools(),
      sentryMcp.getTools(),
    ]);

    // 両方のツールをマージして返す
    return {
      ...githubTools,
      ...sentryTools,
    };
  },
  memory: new Memory({
    storage: new LibSQLStore({
      url: 'file:../mastra.db',
    }),
  }),
});
