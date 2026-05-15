import { webSearch } from '@exalabs/ai-sdk';

/**
 * Standalone web search tool for AI SDK agents and generateText.
 * Uses official @exalabs/ai-sdk with sensible defaults optimized for token efficiency.
 *
 * Features:
 * - Auto-intelligent search (hybrid semantic + keyword)
 * - Returns up to 10 results
 * - Limits content to 3000 characters per result
 * - Automatically reads EXA_API_KEY from environment
 *
 * Usage with ToolLoopAgent:
 * ```ts
 * const agent = new ToolLoopAgent({
 *   model: gateway('anthropic/claude-opus-4.6'),
 *   tools: { webSearch: webSearchTool },
 * });
 * ```
 *
 * Usage with generateText:
 * ```ts
 * const result = await generateText({
 *   model: gateway('openai/gpt-4'),
 *   tools: { webSearch: webSearchTool },
 *   prompt: 'Search for latest AI developments',
 * });
 * ```
 */
export const webSearchTool = webSearch({
  type: 'auto',
  numResults: 10,
  contents: {
    text: {
      maxCharacters: 3000,
    },
  },
});

export default webSearchTool;
