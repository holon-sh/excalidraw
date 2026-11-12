import { AwsClient } from "aws4fetch";

/** Where boards and the files of their images are kept between restarts: text under a key. */
export type Store = {
  read(key: string): Promise<string | undefined>;
  write(key: string, body: string): Promise<void>;
};

/** Keeps boards in this process, so they last as long as the server does. */
export function memory(): Store {
  const objects = new Map<string, string>();
  return {
    read: async (key) => objects.get(key),
    write: async (key, body) => void objects.set(key, body),
  };
}

/** An object nobody has written for this long is written again when it is read. */
const REFRESH = 30 * 24 * 60 * 60_000;

/**
 * Keeps objects in the S3-compatible bucket that the environment names, when
 * its host and key are both set. Holon wants `S3_HOST` wherever the app runs,
 * because the app's egress names it, so the host alone is not enough.
 */
export function bucket(env: NodeJS.ProcessEnv): Store | undefined {
  const { S3_HOST, S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  if (!S3_HOST || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) return undefined;
  const s3 = new AwsClient({
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
    service: "s3",
    region: S3_REGION || "auto",
  });
  // An `http://` host reaches a local server.
  const objects = `${S3_HOST.includes("://") ? S3_HOST : `https://${S3_HOST}`}/${S3_BUCKET || "excalidraw-boards"}`;
  const write = async (key: string, body: string) => {
    const response = await s3.fetch(`${objects}/${key}`, { method: "PUT", body });
    if (!response.ok) throw new Error(`Saving ${key} answered ${response.status}.`);
  };
  return {
    write,
    async read(key) {
      const response = await s3.fetch(`${objects}/${key}`);
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`Reading ${key} answered ${response.status}.`);
      const body = await response.text();
      // A lifecycle rule deletes what nobody has written for a while, which an object in use never is.
      if (Date.now() - Date.parse(response.headers.get("last-modified")!) > REFRESH)
        write(key, body).catch(console.error);
      return body;
    },
  };
}
