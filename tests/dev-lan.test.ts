// Reaching `denext dev` from a device: the `allowedDevOrigins` config key and
// `--allowed-dev-origin` validation, the `--lan` interface pick (injected interfaces), the hosts
// an explicit bind allows, the origin gate letting an allowed LAN host through while still
// refusing others, and the terminal QR code (decoded here by an independent reader).

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { devOriginError, validateDenextConfig } from "../src/server/config-validate.ts";
import type { DenextConfig } from "../src/server/config.ts";
import {
  boundHostOrigins,
  effectiveDevOrigins,
  lanBanner,
  type LanInterface,
  pickLanAddress,
} from "../src/build/dev-server/lan.ts";
import { devOriginAllowed } from "../src/build/dev-server.ts";
import { allowedDevOriginFlag } from "../src/cli/commands/serve.ts";
import { encodeQr, type QrMatrix, renderQrTerminal } from "../src/utils/qr-code.ts";

// --- validation ---------------------------------------------------------------

Deno.test("devOriginError accepts origins and bare hosts", () => {
  for (
    const ok of [
      "http://192.168.1.5:3000",
      "https://dev.example.com",
      "192.168.1.5",
      "192.168.1.5:3000",
      "mac.local",
      "mac.local:3000",
      "fd00::1",
    ]
  ) assertEquals(devOriginError(ok), null, ok);
});

Deno.test("devOriginError refuses wildcards, paths, other schemes and junk", () => {
  const bad: Array<[unknown, string]> = [
    ["*.local", "wildcard"],
    ["http://*.example.com", "wildcard"],
    ["http://192.168.1.5:3000/", "origin like"],
    ["http://192.168.1.5/app", "origin like"],
    ["ftp://host", "http(s)"],
    ["mac.local/path", "host like"],
    ["Mac.Local", "host like"],
    ["", "non-empty"],
    [42, "non-empty"],
    ["a b", "whitespace"],
    ["http://", "valid origin"],
    ["fd00::zz", "IPv6"],
  ];
  for (const [entry, why] of bad) {
    const problem = devOriginError(entry);
    assert(problem !== null, `${String(entry)} must be refused`);
    assertStringIncludes(problem, why);
  }
});

Deno.test("validateDenextConfig checks allowedDevOrigins", () => {
  validateDenextConfig({ allowedDevOrigins: ["192.168.1.5", "http://mac.local:3000"] });
  assertThrows(
    () => validateDenextConfig({ allowedDevOrigins: "192.168.1.5" } as unknown as DenextConfig),
    Error,
    "`allowedDevOrigins` must be an array",
  );
  assertThrows(
    () => validateDenextConfig({ allowedDevOrigins: ["ok.local", "*.local"] }),
    Error,
    "`allowedDevOrigins[1]` has a wildcard",
  );
});

Deno.test("--allowed-dev-origin splits repeats/commas and validates each entry", () => {
  assertEquals(allowedDevOriginFlag(undefined), { ok: true, origins: [] });
  assertEquals(allowedDevOriginFlag("a.local, http://b.local:3000,,"), {
    ok: true,
    origins: ["a.local", "http://b.local:3000"],
  });
  const bad = allowedDevOriginFlag("a.local,*.local");
  assert(!bad.ok);
  assertStringIncludes(bad.error, "--allowed-dev-origin *.local");
});

// --- --lan and explicit binds ---------------------------------------------------

const iface = (name: string, address: string, family = "IPv4"): LanInterface => ({
  name,
  address,
  family,
});

Deno.test("pickLanAddress prefers the primary interface and skips loopback / link-local", () => {
  assertEquals(
    pickLanAddress([
      iface("lo0", "127.0.0.1"),
      iface("utun3", "10.8.0.2"),
      iface("en5", "169.254.10.1"),
      iface("en0", "fe80::1", "IPv6"),
      iface("en0", "192.168.1.5"),
    ]),
    "192.168.1.5",
  );
  // No preferred name: the first usable IPv4 in OS order.
  assertEquals(
    pickLanAddress([iface("lo", "127.0.0.1"), iface("bridge100", "172.20.10.2")]),
    "172.20.10.2",
  );
  assertEquals(
    pickLanAddress([iface("wlan0", "10.0.0.7"), iface("docker0", "172.17.0.1")]),
    "10.0.0.7",
  );
  assertEquals(pickLanAddress([iface("lo0", "127.0.0.1"), iface("en0", "::1", "IPv6")]), null);
});

Deno.test("boundHostOrigins: an explicit bind allows what it binds, loopback adds nothing", () => {
  const ifaces = () => [
    iface("lo0", "127.0.0.1"),
    iface("lo0", "::1", "IPv6"),
    iface("en0", "fe80::1c", "IPv6"),
    iface("en0", "192.168.1.5"),
    iface("en0", "fd00::5", "IPv6"),
  ];
  assertEquals(boundHostOrigins(undefined, ifaces), []);
  assertEquals(boundHostOrigins("localhost", ifaces), []);
  assertEquals(boundHostOrigins("127.0.0.1", ifaces), []);
  assertEquals(boundHostOrigins("192.168.1.5", ifaces), ["192.168.1.5"]);
  assertEquals(boundHostOrigins("[fd00::5]", ifaces), ["fd00::5"]);
  assertEquals(boundHostOrigins("0.0.0.0", ifaces), ["192.168.1.5", "fd00::5"]);
  assertEquals(
    boundHostOrigins("::", () => {
      throw new Deno.errors.NotCapable("sys");
    }),
    [],
  );
});

Deno.test("effectiveDevOrigins merges config, flags and the bind, deduplicated", () => {
  assertEquals(
    effectiveDevOrigins([["a.local", "192.168.1.5"], undefined, ["b.local"]], "192.168.1.5"),
    ["a.local", "192.168.1.5", "b.local"],
  );
});

// --- the origin gate ------------------------------------------------------------

Deno.test("origin gate: an allowed LAN host loads the dev assets, others are still refused", () => {
  const allowed = effectiveDevOrigins([[]], "192.168.1.5");
  const lan = new URL("http://192.168.1.5:3000/_denext/reload");
  const sameOrigin = { "sec-fetch-site": "same-origin" };
  assertEquals(devOriginAllowed(new Request(lan, { headers: sameOrigin }), lan, allowed), true);
  // Another LAN address (a second NIC, a rebinding hostname) is not in the list.
  const other = new URL("http://192.168.1.9:3000/_denext/reload");
  assertEquals(
    devOriginAllowed(new Request(other, { headers: sameOrigin }), other, allowed),
    false,
  );
  const rebind = new URL("http://attacker.example:3000/_denext/reload");
  assertEquals(
    devOriginAllowed(new Request(rebind, { headers: sameOrigin }), rebind, allowed),
    false,
  );
  // An allowed Host does not open the channel to a cross-site page.
  assertEquals(
    devOriginAllowed(
      new Request(lan, { headers: { "sec-fetch-site": "cross-site" } }),
      lan,
      allowed,
    ),
    false,
  );
  // Without the bind, the LAN host is refused as before.
  assertEquals(devOriginAllowed(new Request(lan, { headers: sameOrigin }), lan, []), false);
});

// --- QR ---------------------------------------------------------------------------

/** The eight data masks (ISO/IEC 18004 table 10). */
const MASK: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];

/** BCH(15,5) check of format information, as a reader does it. */
function formatValid(raw: number): boolean {
  let rem = raw >>> 10;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((((raw >>> 10) << 10) | rem) & 0x7fff) === raw;
}

/** Read and check both format-information copies; returns the mask. */
function readFormat(m: QrMatrix): number {
  const size = m.length;
  const bitsAt = (cells: Array<[number, number]>) =>
    cells.reduce((acc, [x, y], i) => acc | ((m[y][x] ? 1 : 0) << i), 0);
  const first: Array<[number, number]> = [
    ...[0, 1, 2, 3, 4, 5].map((i): [number, number] => [8, i]),
    [8, 7],
    [8, 8],
    [7, 8],
    ...[9, 10, 11, 12, 13, 14].map((i): [number, number] => [14 - i, 8]),
  ];
  const second: Array<[number, number]> = [
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i): [number, number] => [size - 1 - i, 8]),
    ...[8, 9, 10, 11, 12, 13, 14].map((i): [number, number] => [8, size - 15 + i]),
  ];
  const f1 = bitsAt(first);
  assertEquals(f1, bitsAt(second), "both format copies agree");
  const format = f1 ^ 0x5412;
  assert(formatValid(format), "format information passes its BCH check");
  assertEquals(format >>> 13, 0, "error-correction level M");
  assertEquals(m[size - 8][8], true, "the dark module");
  return (format >>> 10) & 7;
}

/** Whether (x, y) is a function-pattern module in a version 1 or 2 symbol. */
function isFunctionModule(x: number, y: number, size: number): boolean {
  const corner = (x <= 8 && y <= 8) || (x >= size - 8 && y <= 8) || (x <= 8 && y >= size - 8);
  const alignment = size === 25 && Math.abs(x - 18) <= 2 && Math.abs(y - 18) <= 2;
  return corner || alignment || x === 6 || y === 6;
}

/** Module positions in placement order: two-column strips zigzagging up and down (§7.7.3). */
function* placement(size: number): Generator<[number, number]> {
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let v = 0; v < size; v++) {
      const y = upward ? size - 1 - v : v;
      yield [right, y];
      yield [right - 1, y];
    }
  }
}

/** The unmasked data bits, in placement order. */
function dataBits(m: QrMatrix, mask: number): number[] {
  return [...placement(m.length)]
    .filter(([x, y]) => !isFunctionModule(x, y, m.length))
    .map(([x, y]) => (m[y][x] ? 1 : 0) ^ (MASK[mask](x, y) ? 1 : 0));
}

/**
 * A minimal, independent reader for versions 1–2 at level M (one EC block): check both format
 * copies, unmask, read the zigzag, and parse the byte-mode segment.
 */
function readQr(m: QrMatrix): string {
  assert(m.length === 21 || m.length === 25, "the reader handles versions 1-2");
  const bits = dataBits(m, readFormat(m));
  const read = (from: number, n: number) =>
    bits.slice(from, from + n).reduce((acc, b) => (acc << 1) | b, 0);
  assertEquals(read(0, 4), 0b0100, "byte mode");
  const count = read(4, 8);
  const bytes = Array.from({ length: count }, (_, i) => read(12 + i * 8, 8));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

Deno.test("QR: the dev URL round-trips through an independent reader", () => {
  for (const text of ["a", "http://192.168.1.5:3000", "http://172.20.10.2:3000"]) {
    const m = encodeQr(text);
    assertEquals(m.length, text.length === 1 ? 21 : 25);
    assertEquals(readQr(m), text);
  }
});

Deno.test("QR: finder patterns sit in three corners", () => {
  const m = encodeQr("http://192.168.1.5:3000");
  const n = m.length;
  for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    for (let i = 0; i < 7; i++) {
      assertEquals(m[oy][ox + i], true);
      assertEquals(m[oy + 6][ox + i], true);
      assertEquals(m[oy + 3][ox + 3], true);
      assertEquals(m[oy + 1][ox + 1], false);
    }
  }
});

Deno.test("QR: larger payloads pick larger versions; too long throws", () => {
  assertEquals(encodeQr("x".repeat(60)).length, 4 * 4 + 17);
  assertEquals(encodeQr("y".repeat(150)).length, 8 * 4 + 17); // version info drawn (v7+)
  assertEquals(encodeQr("z".repeat(213)).length, 10 * 4 + 17); // 16-bit count
  assertThrows(() => encodeQr("w".repeat(214)), RangeError);
});

Deno.test("QR: the terminal rendering is two module rows per line inside a quiet zone", () => {
  const m = encodeQr("http://192.168.1.5:3000");
  const lines = renderQrTerminal(m).split("\n");
  assertEquals(lines.length, Math.ceil((m.length + 4) / 2));
  for (const line of lines) assertEquals([...line].length, m.length + 4);
  assertEquals(lines[0], "█".repeat(m.length + 4), "the quiet zone is light");
  assert(lines.slice(1, -1).every((l) => /[ ▀▄]/.test(l)), "every symbol row has dark modules");
});

Deno.test("lanBanner prints the URL and its QR code", () => {
  const banner = lanBanner("http://192.168.1.5:3000");
  assertStringIncludes(banner, "http://192.168.1.5:3000");
  assertStringIncludes(banner, "▀");
  assertStringIncludes(banner, "localhost does not answer");
});
