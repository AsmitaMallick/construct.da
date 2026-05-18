/**
 * Extract and parse JSON from text that may contain:
 * - Markdown code blocks: ```json ... ``` or ``` ... ```
 * - Plain JSON
 * - Text with embedded JSON
 *
 * @param text - Raw text from AI response
 * @returns Parsed JSON object or null on failure
 */
export function parseJsonFromText<T>(text: string): T | null {
  try {
    // direct parse first
    return JSON.parse(text) as T;
  } catch {}

  try {
    // markdown json block
    const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);

    if (match?.[1]) {
      return JSON.parse(match[1]) as T;
    }
  } catch {}

  try {
    // extract first json array/object
    const jsonMatch = text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);

    if (jsonMatch?.[1]) {
      return JSON.parse(jsonMatch[1]) as T;
    }
  } catch {}

  return null;
}