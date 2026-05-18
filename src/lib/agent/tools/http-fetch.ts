import { z } from 'zod';

const httpFetchSchema = z.object({
  url: z.string().url(),
  method: z.enum(['HEAD', 'GET']).default('HEAD'),
  timeoutMs: z.number().default(10000),
});

export type HttpFetchInput = z.infer<typeof httpFetchSchema>;

export async function httpFetch(input: HttpFetchInput) {
  const { url, method, timeoutMs } = httpFetchSchema.parse(input);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      redirect: 'follow',
    });

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    let content = '';
    if (method === 'GET') {
      const text = await response.text();
      content = text.slice(0, 5000);
    }

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      contentType: headers['content-type'] || '',
      lastModified: headers['last-modified'] || '',
      contentLength: headers['content-length'] || '',
      content,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        error: 'Request timeout',
        ok: false,
        status: 0,
        statusText: 'Timeout',
      };
    }
    return {
      error: error instanceof Error ? error.message : 'Unknown error',
      ok: false,
      status: 0,
      statusText: 'Error',
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export const httpFetchTool = {
  description: 'Fetch HTTP headers or content from a URL. Use HEAD for headers only, GET for content.',
  parameters: httpFetchSchema,
  execute: async (input: HttpFetchInput) => {
    const result = await httpFetch(input);
    return result;
  },
};

export default httpFetchTool;