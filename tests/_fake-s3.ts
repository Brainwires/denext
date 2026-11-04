// An in-memory S3 for the backend storage tests: the REST calls the `s3()` driver makes
// (path-style), including presigned URLs, ranges, ListObjectsV2 paging with `encoding-type=url`
// multipart uploads and CopyObject. It checks that every request is SigV4-signed (header or query form)
// and that a presigned request carries the headers it signed. With `verify` set it also
// recomputes a presigned URL's signature from the request as it arrives — the way S3 does — so
// a body whose length differs from a signed `content-length` is refused; otherwise it does not
// recompute signatures (the signer is verified against AWS's own vectors in
// backend-sigv4.test.ts).

import { type AwsCredentials, presignUrl } from "../packages/backend/src/sigv4.ts";

interface StoredS3 {
  body: Uint8Array;
  contentType: string;
  etag: string;
  modified: Date;
}

/** A fake S3 endpoint: hand `fetch` to `s3({ fetch })`. */
export class FakeS3 {
  readonly objects = new Map<string, StoredS3>();
  readonly uploads = new Map<
    string,
    { key: string; contentType: string; parts: Map<number, Uint8Array> }
  >();
  readonly calls: { method: string; url: string }[] = [];
  /** When set, the next request with this method answers 500 with an S3 error body. */
  failNext: string | null = null;
  /** When set, presigned requests are checked against a signature recomputed as S3 would. */
  verify: { region: string; credentials: AwsCredentials } | null = null;
  #seq = 0;

  constructor(readonly bucket = "test-bucket") {}

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let request = new Request(input, init);
    const url = new URL(request.url);
    this.calls.push({ method: request.method, url: request.url });
    if (this.failNext === request.method) {
      this.failNext = null;
      return xml(
        500,
        "<Error><Code>InternalError</Code><Message>boom &amp; bust</Message></Error>",
      );
    }
    const refused = this.#unsigned(request, url);
    if (refused) return refused;
    if (this.verify && url.searchParams.has("X-Amz-Signature")) {
      const checked = await this.#verified(request, url);
      if (checked instanceof Response) return checked;
      request = checked;
    }
    const prefix = `/${this.bucket}`;
    if (!url.pathname.startsWith(prefix)) {
      return xml(404, "<Error><Code>NoSuchBucket</Code></Error>");
    }
    const key = decodeURIComponent(url.pathname.slice(prefix.length + 1));
    if (!key) return this.#list(url);
    return await this.#object(request, url, key);
  };

  /** A refusal for an unsigned request, or one missing a header its presigned URL signed. */
  #unsigned(request: Request, url: URL): Response | null {
    const auth = request.headers.get("authorization") ?? url.searchParams.get("X-Amz-Signature");
    if (!auth) return xml(403, "<Error><Code>AccessDenied</Code></Error>");
    // `host` and `content-length` are set by fetch on the wire, not on the Request object.
    const missing = (url.searchParams.get("X-Amz-SignedHeaders") ?? "").split(";").find((name) =>
      name && name !== "host" && name !== "content-length" && !request.headers.has(name)
    );
    return missing === undefined
      ? null
      : xml(403, `<Error><Code>SignatureDoesNotMatch</Code><Message>${missing}</Message></Error>`);
  }

  /** The request again (its body buffered) when its presigned signature holds, else a 403. */
  async #verified(request: Request, url: URL): Promise<Request | Response> {
    const body = new Uint8Array(await request.arrayBuffer());
    if (!await this.#presignMatches(request, url, body)) {
      return xml(403, "<Error><Code>SignatureDoesNotMatch</Code></Error>");
    }
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    return new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: hasBody ? body as BodyInit : null,
    });
  }

  /** Recompute a presigned URL's signature from what arrived (a signed length is the body's). */
  async #presignMatches(request: Request, url: URL, body: Uint8Array): Promise<boolean> {
    const q = url.searchParams;
    const headers: Record<string, string> = {};
    for (const name of (q.get("X-Amz-SignedHeaders") ?? "").split(";")) {
      if (name === "host") continue;
      headers[name] = name === "content-length"
        ? String(body.byteLength)
        : request.headers.get(name) ?? "";
    }
    const query: Record<string, string> = {};
    for (const [k, v] of q) if (!k.startsWith("X-Amz-")) query[k] = v;
    const d = q.get("X-Amz-Date") ?? "";
    const date = new Date(
      `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${
        d.slice(13, 15)
      }Z`,
    );
    const again = await presignUrl(
      {
        method: request.method,
        origin: url.origin,
        path: decodeURIComponent(url.pathname),
        query,
        headers,
      },
      { region: this.verify!.region, service: "s3", credentials: this.verify!.credentials, date },
      Number(q.get("X-Amz-Expires")),
    );
    return new URL(again).searchParams.get("X-Amz-Signature") === q.get("X-Amz-Signature");
  }

  async #object(request: Request, url: URL, key: string): Promise<Response> {
    const q = url.searchParams;
    switch (request.method) {
      case "PUT":
        return q.has("partNumber")
          ? await this.#putPart(request, q)
          : await this.#put(request, key);
      case "GET":
      case "HEAD":
        return this.#get(request, key);
      case "DELETE":
        if (q.has("uploadId")) {
          return this.uploads.delete(q.get("uploadId")!)
            ? new Response(null, { status: 204 })
            : xml(404, "<Error><Code>NoSuchUpload</Code></Error>");
        }
        this.objects.delete(key);
        return new Response(null, { status: 204 });
      case "POST":
        return q.has("uploads")
          ? this.#create(request, key)
          : await this.#complete(request, q, key);
    }
    return xml(405, "<Error><Code>MethodNotAllowed</Code></Error>");
  }

  async #put(request: Request, key: string): Promise<Response> {
    const source = request.headers.get("x-amz-copy-source");
    if (source !== null) return this.#copy(source, key);
    const body = new Uint8Array(await request.arrayBuffer());
    const etag = `etag${++this.#seq}`;
    this.objects.set(key, {
      body,
      contentType: request.headers.get("content-type") ?? "binary/octet-stream",
      etag,
      modified: new Date(),
    });
    return new Response(null, { headers: { etag: `"${etag}"` } });
  }

  /** CopyObject: the source's bytes and type (S3's default `COPY` metadata directive). */
  #copy(source: string, key: string): Response {
    const prefix = `/${this.bucket}/`;
    if (!source.startsWith(prefix)) return xml(404, "<Error><Code>NoSuchBucket</Code></Error>");
    const from = this.objects.get(decodeURIComponent(source.slice(prefix.length)));
    if (!from) return xml(404, "<Error><Code>NoSuchKey</Code></Error>");
    const etag = `etag${++this.#seq}`;
    const modified = new Date();
    this.objects.set(key, { ...from, body: from.body.slice(), etag, modified });
    return xml(
      200,
      `<CopyObjectResult><ETag>"${etag}"</ETag><LastModified>${modified.toISOString()}` +
        `</LastModified></CopyObjectResult>`,
    );
  }

  async #putPart(request: Request, q: URLSearchParams): Promise<Response> {
    const upload = this.uploads.get(q.get("uploadId") ?? "");
    if (!upload) return xml(404, "<Error><Code>NoSuchUpload</Code></Error>");
    upload.parts.set(Number(q.get("partNumber")), new Uint8Array(await request.arrayBuffer()));
    return new Response(null, { headers: { etag: `"part${q.get("partNumber")}"` } });
  }

  #get(request: Request, key: string): Response {
    const obj = this.objects.get(key);
    if (!obj) {
      return request.method === "HEAD"
        ? new Response(null, { status: 404 })
        : xml(404, "<Error><Code>NoSuchKey</Code></Error>");
    }
    const headers = new Headers({
      "content-type": obj.contentType,
      etag: `"${obj.etag}"`,
      "last-modified": obj.modified.toUTCString(),
    });
    const range = request.headers.get("range")?.match(/^bytes=(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), obj.body.byteLength - 1);
      headers.set("content-range", `bytes ${start}-${end}/${obj.body.byteLength}`);
      headers.set("content-length", String(end - start + 1));
      return new Response(
        request.method === "HEAD" ? null : obj.body.slice(start, end + 1) as BodyInit,
        { status: 206, headers },
      );
    }
    headers.set("content-length", String(obj.body.byteLength));
    return new Response(request.method === "HEAD" ? null : obj.body as BodyInit, { headers });
  }

  #create(request: Request, key: string): Response {
    const id = `upload-${++this.#seq}`;
    this.uploads.set(id, {
      key,
      contentType: request.headers.get("content-type") ?? "",
      parts: new Map(),
    });
    return xml(
      200,
      `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
    );
  }

  async #complete(request: Request, q: URLSearchParams, key: string): Promise<Response> {
    const id = q.get("uploadId") ?? "";
    const upload = this.uploads.get(id);
    if (!upload) return xml(404, "<Error><Code>NoSuchUpload</Code></Error>");
    const body = await request.text();
    const numbers = [...body.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]));
    if (numbers.some((n) => !upload.parts.has(n))) {
      return xml(200, "<Error><Code>InvalidPart</Code><Message>missing part</Message></Error>");
    }
    const chunks = numbers.map((n) => upload.parts.get(n)!);
    const total = chunks.reduce((a, c) => a + c.byteLength, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    this.objects.set(key, {
      body: out,
      contentType: upload.contentType,
      etag: `mp${++this.#seq}`,
      modified: new Date(),
    });
    this.uploads.delete(id);
    return xml(
      200,
      "<CompleteMultipartUploadResult><ETag>&quot;mp&quot;</ETag></CompleteMultipartUploadResult>",
    );
  }

  #list(url: URL): Response {
    const q = url.searchParams;
    const prefix = q.get("prefix") ?? "";
    const max = Number(q.get("max-keys") ?? 1000);
    const after = q.get("continuation-token") ?? "";
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
    const page = keys.slice(0, max);
    const truncated = keys.length > page.length;
    const enc = (k: string) =>
      q.get("encoding-type") === "url" ? encodeURIComponent(k).replace(/%20/g, "+") : k;
    const contents = page.map((k) => {
      const o = this.objects.get(k)!;
      return `<Contents><Key>${
        enc(k)
      }</Key><Size>${o.body.byteLength}</Size><ETag>&quot;${o.etag}&quot;</ETag><LastModified>${o.modified.toISOString()}</LastModified></Contents>`;
    }).join("");
    return xml(
      200,
      `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${contents}${
        truncated ? `<NextContinuationToken>${page[page.length - 1]}</NextContinuationToken>` : ""
      }</ListBucketResult>`,
    );
  }
}

function xml(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "application/xml" } });
}
