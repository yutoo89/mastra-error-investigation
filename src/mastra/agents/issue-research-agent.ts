import { openai } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { createGitHubMCPClient } from '../mcp/github-mcp';

/**
 * Issue Research Agent - GitHub を使って issue の原因を調査するエージェント
 *
 * このエージェントは GitHub MCP ツールを使用し、
 * issue の詳細情報を取得し、関連するコードを検索・調査して、
 * 根本原因の特定や修正箇所の候補を提示します。
 *
 * 主な機能:
 * - GitHub: コード検索、ファイル内容取得、コミット履歴調査
 *
 * 環境変数:
 * - GITHUB_MCP_TOKEN: GitHub Personal Access Token
 */

/**
 * 使用を許可する GitHub ツールのホワイトリスト
 * issue 調査に必要な読み取り系ツールのみを厳選
 */
const ALLOWED_GITHUB_TOOLS = [
  'github_search_code',        // ★ 復活（ただし使い方の指示を厳格化）
  'github_get_file_contents',
  'github_get_commit',
  'github_list_commits',
  'github_list_pull_requests',
  'github_pull_request_read',
];

// GitHub MCP クライアントとツールを事前初期化
let cachedGithubTools: Record<string, any> | null = null;
let toolsInitPromise: Promise<Record<string, any>> | null = null;

async function initializeGithubTools(): Promise<Record<string, any>> {
  // 既にキャッシュされている場合は即座に返す
  if (cachedGithubTools) {
    console.log('[issueResearchAgent] Using cached GitHub tools');
    return cachedGithubTools;
  }

  // 初期化中の場合は同じPromiseを返す
  if (toolsInitPromise) {
    console.log('[issueResearchAgent] GitHub tools initialization already in progress');
    return toolsInitPromise;
  }

  // 初期化開始
  toolsInitPromise = (async () => {
    try {
      console.log('[issueResearchAgent] Initializing GitHub MCP client...');

      // GitHub MCP クライアントを初期化（Promiseを返す場合に対応）
      const githubMcp = createGitHubMCPClient();
      const resolvedMcp = githubMcp instanceof Promise ? await githubMcp : githubMcp;

      console.log('[issueResearchAgent] GitHub MCP client initialized');

      // 全ツールを取得
      console.log('[issueResearchAgent] Fetching GitHub tools...');
      const githubAllTools = await resolvedMcp.getTools();

      console.log('[issueResearchAgent] Available tools:', Object.keys(githubAllTools));

      // ホワイトリストでフィルタリング
      cachedGithubTools = Object.fromEntries(
        Object.entries(githubAllTools).filter(([toolId]) =>
          ALLOWED_GITHUB_TOOLS.includes(toolId)
        )
      );

      console.log(`[issueResearchAgent] Initialized ${Object.keys(cachedGithubTools).length} GitHub tools`);
      console.log('[issueResearchAgent] Whitelisted tools:', Object.keys(cachedGithubTools));

      // ツールが空の場合は警告
      if (Object.keys(cachedGithubTools).length === 0) {
        console.warn('[issueResearchAgent] WARNING: No tools available after filtering!');
        console.warn('[issueResearchAgent] Whitelist:', ALLOWED_GITHUB_TOOLS);
        console.warn('[issueResearchAgent] Available tools:', Object.keys(githubAllTools));
      }

      return cachedGithubTools;
    } catch (error) {
      console.error('[issueResearchAgent] Failed to initialize GitHub tools:', error);
      console.error('[issueResearchAgent] Error details:', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      // 初期化失敗時は空のツールセットを返す
      cachedGithubTools = {};
      return cachedGithubTools;
    } finally {
      toolsInitPromise = null;
    }
  })();

  return toolsInitPromise;
}

export const issueResearchAgent = new Agent({
  name: 'Issue Research Agent',
  description: 'GitHub を使って issue の原因を調査するエージェント',
  instructions: `
    あなたは Sentry issue の原因を調査するエージェントです。
    GitHub ツールを駆使して根本原因を特定し、修正箇所の候補を提示してください。

    ### 重要な制約（レート制限を回避しつつ確実に調査すること）
    - **github_search_code は使用してよいが、節度を持って最小回数に抑えること。**
      - ファイル名がわかっている場合は github_get_file_contents を直接使って確認する
      - レート制限（HTTP 403/429 もしくは "rate limit" を含むエラー文言）に当たった場合は、即座に別手段へ切り替える
    - レート制限やエラーが発生した場合の**別手段**:
      1) Sentry スタックトレースのファイル名や関数名からパスを推定し、**github_get_file_contents** を直接使って確認する
         - 典型的なルート（例: src/, app/, pages/, server/, lib/ など）を優先的に試す
      2) 直近変更点を当たりたい場合は、**github_list_commits** / **github_get_commit** でファイル変更の有無を確認する
      3) どうしても特定できない場合は、**検索は中断**し、判明している事実と仮説、追加観測ポイントを簡潔に出力する
    - 同じ情報を得るための**重複検索は禁止**。すでに取得したファイル内容やメタ情報を再利用すること。

    ## 利用可能なツール:

    - github_search_code: キーワードから関連ファイル候補を少数列挙（必要最小限の回数のみ）
    - github_get_file_contents: 該当ファイルの内容を確認
    - github_get_commit: 特定のコミットの詳細を取得
    - github_list_commits: ファイルやパスの変更履歴を調査
    - github_list_pull_requests: 関連するPRを検索
    - github_pull_request_read: PR の詳細を確認

    ## 調査手順:

    1. **コード深掘り**

      * スタックトレースから関連ファイルと行番号を特定
      * 必要に応じて **github_search_code** を使い、候補を絞る
      * **github_get_file_contents** で内容と周辺コードを確認（検索に失敗したら推定パスで直接取得を試行）
      * 呼び出し元/先から関連ファイル集合を作成
      * 根因仮説と根拠をまとめる（ファイル・行番号必須、引用は短く）

    2. **詳しい人候補の抽出**

      * 関連ファイルのコミット履歴や最近のPRを参照
      * 上位3名のGitHubユーザーを候補として提示（根拠を一言添える）

    3. **対応判定**

      * 顧客影響の可能性、イベント頻度、再発傾向で判断
      * 曖昧な場合は「仮説」明記＋「要追加追跡」を記載

    ## 条件:

    - 必ずソースコードの該当箇所を参照して回答すること
    - 調査には十分な深さで取り組むこと（複数のツールを組み合わせて使用）
    - 調査結果はマークダウン形式で整理して出力すること
  `,
  model: openai('gpt-5-mini'),
  tools: async () => {
    // 事前初期化されたツールを返す（並列実行時も安全）
    return await initializeGithubTools();
  },
});
