import { put } from "@vercel/blob";

export async function uploadToBlob(
  councilId: string,
  state: string,
  filename: string,
  content: Buffer | string,
  contentType: string
): Promise<string> {
  const path = `${state}/${councilId}/${filename}`;
  const { url } = await put(path, content, {
    access: "public",
    contentType,
    token: process.env.BLOB_READ_WRITE_TOKEN!,
  });
  return url;
}