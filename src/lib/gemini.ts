import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

// Primary model: Gemini 2.5 Flash (fast + capable for reasoning tasks)
export const geminiPro = new ChatGoogleGenerativeAI({
  model: "gemini-2.5-flash-preview-05-20",
  temperature: 0.2,          // low temp for deterministic credibility decisions
  maxRetries: 3,
  apiKey: process.env.GEMINI_API_KEY!,
});

// Fast model: for quick domain/URL classification (high throughput)
export const geminiFlash = new ChatGoogleGenerativeAI({
  model: "gemini-2.0-flash",
  temperature: 0,
  maxRetries: 3,
  apiKey: process.env.GEMINI_API_KEY!,
});

// Helper: call Gemini and get raw text back
export async function askGemini(
  model: ChatGoogleGenerativeAI,
  prompt: string
): Promise<string> {
  const response = await model.invoke(prompt);
  return typeof response.content === "string"
    ? response.content
    : JSON.stringify(response.content);
}