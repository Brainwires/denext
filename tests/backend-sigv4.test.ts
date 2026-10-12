// @denext/backend: the SigV4 signer against AWS's published test vectors — the generic
// `get-vanilla` case of the aws-sig-v4 test suite, the signing-key derivation example, and the
// five S3 examples from "Authenticating Requests (AWS Signature Version 4)" (header-signed GET
// with a Range, PUT with a body, ?lifecycle, ListObjects, and a presigned GET URL).

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  amzDate,
  presignUrl,
  sha256Hex,
  signingKey,
  signRequest,
  uriEncode,
} from "../packages/backend/src/sigv4.ts";

const S3_CREDENTIALS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const S3_SCOPE = {
  region: "us-east-1",
  service: "s3",
  credentials: S3_CREDENTIALS,
  date: new Date(Date.UTC(2013, 4, 24)),
};
const ORIGIN = "https://examplebucket.s3.amazonaws.com";
const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function signatureOf(authorization: string): string {
  return authorization.split("Signature=")[1];
}

Deno.test("sigv4: signing key derivation matches the AWS example (iam, 20120215)", async () => {
  const key = await signingKey(
    "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    "20120215",
    "us-east-1",
    "iam",
  );
  assertEquals(
    [...key].map((b) => b.toString(16).padStart(2, "0")).join(""),
    "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d",
  );
});

Deno.test("sigv4: aws-sig-v4-test-suite get-vanilla", async () => {
  const signed = await signRequest(
    { method: "GET", origin: "https://example.amazonaws.com", path: "/" },
    {
      region: "us-east-1",
      service: "service",
      credentials: {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      },
      date: new Date(Date.UTC(2015, 7, 30, 12, 36)),
    },
    EMPTY_SHA,
  );
  assertEquals(
    signed.headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
      "SignedHeaders=host;x-amz-date, " +
      "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  );
  assertEquals(signed.headers["x-amz-date"], "20150830T123600Z");
  assert(!("x-amz-content-sha256" in signed.headers), "only S3 sends the payload hash header");
});

Deno.test("sigv4: S3 GET object with a Range header", async () => {
  const signed = await signRequest(
    { method: "GET", origin: ORIGIN, path: "/test.txt", headers: { Range: "bytes=0-9" } },
    S3_SCOPE,
    EMPTY_SHA,
  );
  assertEquals(
    signatureOf(signed.headers.authorization),
    "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
  assertStringIncludes(
    signed.headers.authorization,
    "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date",
  );
  assertEquals(signed.url, `${ORIGIN}/test.txt`);
});

Deno.test("sigv4: S3 PUT object (payload hashed, `$` percent-encoded in the path)", async () => {
  const signed = await signRequest(
    {
      method: "PUT",
      origin: ORIGIN,
      path: "/test$file.text",
      headers: {
        date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
    },
    S3_SCOPE,
    await sha256Hex("Welcome to Amazon S3."),
  );
  assertEquals(
    signatureOf(signed.headers.authorization),
    "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
  );
  assertEquals(signed.url, `${ORIGIN}/test%24file.text`);
});

Deno.test("sigv4: S3 GET bucket lifecycle (an empty query value)", async () => {
  const signed = await signRequest(
    { method: "GET", origin: ORIGIN, path: "/", query: { lifecycle: "" } },
    S3_SCOPE,
    EMPTY_SHA,
  );
  assertEquals(
    signatureOf(signed.headers.authorization),
    "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
  );
  assertEquals(signed.url, `${ORIGIN}/?lifecycle=`);
});

Deno.test("sigv4: S3 ListObjects (query parameters sorted)", async () => {
  const signed = await signRequest(
    { method: "GET", origin: ORIGIN, path: "/", query: { prefix: "J", "max-keys": "2" } },
    S3_SCOPE,
    EMPTY_SHA,
  );
  assertEquals(
    signatureOf(signed.headers.authorization),
    "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
  );
});

Deno.test("sigv4: S3 presigned GET URL (86400 s)", async () => {
  const url = new URL(
    await presignUrl({ method: "GET", origin: ORIGIN, path: "/test.txt" }, S3_SCOPE, 86400),
  );
  assertEquals(
    url.searchParams.get("X-Amz-Signature"),
    "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
  );
  assertEquals(
    url.searchParams.get("X-Amz-Credential"),
    "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
  );
  assertEquals(url.searchParams.get("X-Amz-SignedHeaders"), "host");
  assertEquals(url.searchParams.get("X-Amz-Expires"), "86400");
});

Deno.test("sigv4: temporary credentials add the security token (header and query forms)", async () => {
  const scope = { ...S3_SCOPE, credentials: { ...S3_CREDENTIALS, sessionToken: "TOKEN/+=" } };
  const signed = await signRequest({ method: "GET", origin: ORIGIN, path: "/a" }, scope, EMPTY_SHA);
  assertEquals(signed.headers["x-amz-security-token"], "TOKEN/+=");
  assertStringIncludes(signed.headers.authorization, "x-amz-security-token");
  const url = new URL(
    await presignUrl(
      { method: "PUT", origin: ORIGIN, path: "/a", headers: { "Content-Type": "image/png" } },
      scope,
      60,
    ),
  );
  assertEquals(url.searchParams.get("X-Amz-Security-Token"), "TOKEN/+=");
  assertEquals(url.searchParams.get("X-Amz-SignedHeaders"), "content-type;host");
});

Deno.test("sigv4: uriEncode is RFC 3986 over UTF-8 bytes; amzDate drops separators", () => {
  assertEquals(uriEncode("a b/ü~*"), "a%20b%2F%C3%BC~%2A");
  assertEquals(uriEncode("/a b/c", true), "/a%20b/c");
  assertEquals(amzDate(new Date(Date.UTC(2015, 7, 30, 12, 36, 0, 123))), "20150830T123600Z");
});
