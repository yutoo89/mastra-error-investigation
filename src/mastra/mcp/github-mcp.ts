import { MCPClient } from '@mastra/mcp';

/**
 * GitHub Remote MCP Server に接続するクライアント
 *
 * 環境変数:
 * - GITHUB_MCP_URL: GitHub MCP サーバーのエンドポイント URL
 *   デフォルト: https://api.githubcopilot.com/mcp/
 * - GITHUB_MCP_TOKEN: GitHub Personal Access Token (PAT)
 *   必要なスコープ: repo, read:org
 *   トークン作成: https://github.com/settings/tokens
 *
 * 参考:
 * - GitHub MCP Server: https://github.com/github/github-mcp-server
 * - Mastra MCP Client: https://mastra.ai/reference/tools/mcp-client
 */

// シングルトンインスタンスをキャッシュ
let mcpClientInstance: MCPClient | null = null;

export function createGitHubMCPClient(): MCPClient {
  // 既にインスタンスが存在する場合は再利用
  if (mcpClientInstance) {
    return mcpClientInstance;
  }

  // .env から取得（なければデフォルトURL）
  const mcpUrl = process.env.GITHUB_MCP_URL || 'https://api.githubcopilot.com/mcp/';
  const mcpToken = process.env.GITHUB_MCP_TOKEN;

  if (!mcpToken) {
    throw new Error(
      'GITHUB_MCP_TOKEN environment variable is required. ' +
      'Create a Personal Access Token at https://github.com/settings/tokens ' +
      'with scopes: repo, read:org'
    );
  }

  mcpClientInstance = new MCPClient({
    // ユニークIDを設定してメモリリークエラーを回避
    id: 'github-mcp-client',
    servers: {
      github: {
        // GitHub Remote MCP Server (公式)
        // Enterprise Cloud (ghe.com) を使う場合は組織の URL に変更
        url: new URL(mcpUrl),

        // Streamable HTTP: JSON-RPC を POST するため Accept/Content-Type を明示
        requestInit: {
          headers: {
            'Authorization': `Bearer ${mcpToken}`,
            'Accept': 'application/json, text/event-stream',
            'Content-Type': 'application/json',
          },
        },

        // SSE フォールバック: fetch ラッパーでヘッダーを確実に伝播
        eventSourceInit: {
          fetch(input, init) {
            const headers = new Headers(init?.headers || {});
            headers.set('Authorization', `Bearer ${mcpToken}`);
            return fetch(input as Request | URL | string, { ...init, headers });
          },
        },

        // サーバー単位のタイムアウト（60秒）
        timeout: 60_000,
      },
    },
  });

  return mcpClientInstance;
}

