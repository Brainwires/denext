// An in-memory S3 for the backend storage tests: the REST calls the `s3()` driver makes
// (path-style), including presigned URLs, ranges, ListObjectsV2 paging with `encoding-type=url`
// and multipart uploads. It checks that every request is SigV4-signed (header or query form)
// and that a presigned request carries the headers it signed; it does not recompute signatures
// (the signer is verified against AWS's own vectors in backend-sigv4.test.ts).

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
  #seq = 0;

  constructor(readonly bucket = "test-bucket") {}

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    this.calls.push({ method: request.method, url: request.url });
    if (this.failNext === request.method) {
      this.failNext = null;
      return xml(
        500,
        "<Error><Code>InternalError</Code><Message>boom &amp; bust</Message></Error>",
      );
    }
    const auth = request.headers.get("authorization") ?? url.searchParams.get("X-Amz-Signature");
    if (!auth) return xml(403, "<Error><Code>AccessDenied</Code></Error>");
    const signed = url.searchParams.get("X-Amz-SignedHeaders");
    if (signed) {
      for (const name of signed.split(";")) {
        // `host` and `content-length` are set by fetch on the wire, not on the Request object.
        if (name !== "host" && name !== "content-length" && !request.headers.has(name)) {
          return xml(
            403,
            `<Error><Code>SignatureDoesNotMatch</Code><Message>${name}</Message></Error>`,
          );
        }
      }
    }
    const prefix = `/${this.bucket}`;
    if (!url.pathname.startsWith(prefix)) {
      return xml(404, "<Error><Code>NoSuchBucket</Code></Error>");
    }
    const key = decodeURIComponent(url.pathname.slice(prefix.length + 1));
    if (!key) return this.#list(url);
    return await this.#object(request, url, key);
  };

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
