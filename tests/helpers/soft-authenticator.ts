// A software WebAuthn authenticator (ES256, `none` attestation) for the passkey suites, with the
// minimal CBOR encoder it needs.

const ORIGIN = "https://app.test";

export type Cbor = number | string | Uint8Array | Cbor[] | Map<number | string, Cbor>;

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function cbor(value: Cbor): Uint8Array {
  const out: number[] = [];
  const put = (v: Cbor): void => {
    if (typeof v === "number") out.push(...(v >= 0 ? head(0, v) : head(1, -1 - v)));
    else if (typeof v === "string") {
      const bytes = new TextEncoder().encode(v);
      out.push(...head(3, bytes.length), ...bytes);
    } else if (v instanceof Uint8Array) out.push(...head(2, v.length), ...v);
    else if (Array.isArray(v)) {
      out.push(...head(4, v.length));
      v.forEach(put);
    } else {
      out.push(...head(5, v.size));
      for (const [k, item] of v) {
        put(k);
        put(item);
      }
    }
  };
  put(value);
  return Uint8Array.from(out);
}

// ---- a software authenticator ------------------------------------------------------------

export const b64u = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
export const fromB64u = (s: string) =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
const sha256 = async (bytes: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), at += p.length);
  return out;
};

/** Raw r‖s → DER (what an authenticator emits for ES256, WebAuthn §6.5.5). */
function toDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.subarray(i);
    const body = v[0] & 0x80 ? concat(Uint8Array.of(0), v) : v;
    return concat(Uint8Array.of(0x02, body.length), body);
  };
  const seq = concat(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return concat(Uint8Array.of(0x30, seq.length), seq);
}

/** An ES256 authenticator holding one credential. */
export class Authenticator {
  counter = 0;
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16));
  constructor(
    private readonly keys: CryptoKeyPair,
    /** The COSE public key, as a registration stores it. */
    readonly cose: Uint8Array,
    /** UV + BE flags it reports. */
    public flags = 0x05,
  ) {}

  static async create(): Promise<Authenticator> {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    const cose = cbor(
      new Map<number, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, fromB64u(jwk.x!)], [
        -3,
        fromB64u(jwk.y!),
      ]]),
    );
    return new Authenticator(keys, cose);
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  async authData(rpId: string, attested: boolean): Promise<Uint8Array> {
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, this.counter);
    const flags = Uint8Array.of(this.flags | (attested ? 0x40 : 0));
    const base = concat(await sha256(new TextEncoder().encode(rpId)), flags, counter);
    if (!attested) return base;
    const len = Uint8Array.of(0, this.credentialId.length);
    return concat(base, new Uint8Array(16), len, this.credentialId, this.cose);
  }

  clientData(type: string, challenge: string, origin: string): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    );
  }

  /** A `RegistrationResponseJSON` for `options` (the server's creation options). */
  async register(
    options: { challenge: string; rp: { id: string } },
    over: { origin?: string; rpId?: string } = {},
  ) {
    const clientDataJSON = this.clientData(
      "webauthn.create",
      options.challenge,
      over.origin ?? ORIGIN,
    );
    const authData = await this.authData(over.rpId ?? options.rp.id, true);
    const attestationObject = cbor(
      new Map<string, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ["internal"],
      },
    };
  }

  /** An `AuthenticationResponseJSON` for `options`, as this authenticator signs it. */
  // fallow-ignore-next-line unused-class-member -- called by the passkey suites (auth.assert)
  async assert(
    options: { challenge: string; rpId: string },
    over: { origin?: string; userHandle?: string; counter?: number } = {},
  ) {
    if (over.counter === undefined) this.counter++;
    else this.counter = over.counter;
    const clientDataJSON = this.clientData(
      "webauthn.get",
      options.challenge,
      over.origin ?? ORIGIN,
    );
    const authenticatorData = await this.authData(options.rpId, false);
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        this.keys.privateKey,
        concat(authenticatorData, await sha256(clientDataJSON)) as BufferSource,
      ),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authenticatorData),
        signature: b64u(toDer(raw)),
        ...(over.userHandle ? { userHandle: over.userHandle } : {}),
      },
    };
  }
}
