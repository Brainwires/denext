// The SQL vault (`backend({ vault: { sql: true } })`): Supabase Vault's SQL surface —
// `vault.create_secret()`, `vault.update_secret()` and the `vault.decrypted_secrets` view — over
// the same rows and the same ciphertext as the app-side vault (`vault.ts`), so either side reads
// what the other wrote.
//
// The format is AES-256-GCM with a 96-bit nonce, the row id (text) as additional authenticated
// data, and `secret` = base64(ciphertext || 16-byte tag). pgcrypto has no GCM, so it is built here
// from AES-256 single blocks (`encrypt(…, 'aes-ecb/pad:none')`): CTR for the data and GHASH over
// GF(2^128) for the tag, exactly as NIST SP 800-38D specifies; the tests check it against
// WebCrypto in both directions.
//
// The key never lives in the database. The app derives the keys (HKDF, as `vault.ts` does) and sets
// them for one transaction — `set_config('denext.vault_keys', $1, true)`, a bound parameter, so the
// key is not in any statement's text — only in transactions it opens itself (`vault.withKey()`,
// `denext db push`). Outside those, every function here raises "no key in this transaction".

import type { Migration } from "@denext/denext/server";
import type { VaultKey } from "./vault.ts";

/** The transaction-local setting the keys travel in. */
export const VAULT_KEYS_SETTING = "denext.vault_keys";

/** Lowercase hex, as Postgres's `decode(…, 'hex')` reads it. */
function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += (b + 0x100).toString(16).slice(1);
  return out;
}

/**
 * The keys as the setting carries them: `[{ "id": key_id, "key": hex }]`, the encrypting key first.
 *
 * @param keys The derived keys.
 * @returns The JSON text.
 */
export function vaultKeysJson(keys: readonly VaultKey[]): string {
  return JSON.stringify(keys.map((k) => ({ id: k.id, key: hex(k.raw) })));
}

/** The functions, with `@pgcrypto@` standing for pgcrypto's schema (qualified at migration time). */
const FUNCTIONS = String.raw`
CREATE OR REPLACE FUNCTION vault._keys() RETURNS jsonb
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  raw text := current_setting('${VAULT_KEYS_SETTING}', true);
BEGIN
  IF raw IS NULL OR raw = '' THEN
    RAISE EXCEPTION 'vault: no key in this transaction' USING ERRCODE = '28000',
      HINT = 'The key never lives in the database: run vault SQL inside vault.withKey() from '
        || '@denext/backend/server, or through denext db push.';
  END IF;
  RETURN raw::jsonb;
END $fn$;

CREATE OR REPLACE FUNCTION vault._key(wanted uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  k jsonb;
BEGIN
  FOR k IN SELECT * FROM jsonb_array_elements(vault._keys()) LOOP
    IF wanted IS NULL OR (k ->> 'id')::uuid = wanted THEN RETURN k; END IF;
  END LOOP;
  RAISE EXCEPTION 'vault: no configured key has the id %', wanted USING ERRCODE = '22023';
END $fn$;

CREATE OR REPLACE FUNCTION vault._bits(b bytea) RETURNS bit(128)
LANGUAGE sql IMMUTABLE AS $fn$ SELECT ('x' || encode(b, 'hex'))::bit(128) $fn$;

CREATE OR REPLACE FUNCTION vault._bytes(b bit(128)) RETURNS bytea
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT decode(lpad(to_hex(substring(b FROM 1 FOR 64)::bit(64)::bigint), 16, '0')
    || lpad(to_hex(substring(b FROM 65 FOR 64)::bit(64)::bigint), 16, '0'), 'hex')
$fn$;

CREATE OR REPLACE FUNCTION vault._block(key bytea, block bytea) RETURNS bytea
LANGUAGE sql IMMUTABLE AS $fn$ SELECT @pgcrypto@.encrypt(block, key, 'aes-ecb/pad:none') $fn$;

-- Multiplication in GF(2^128), GCM's bit order (SP 800-38D, algorithm 1).
CREATE OR REPLACE FUNCTION vault._gmul(x bit(128), y bit(128)) RETURNS bit(128)
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  z bit(128) := B'0'::bit(128);
  v bit(128) := y;
  r bit(128) := ('x' || 'e1' || repeat('0', 30))::bit(128);
BEGIN
  FOR i IN 0..127 LOOP
    IF get_bit(x, i) = 1 THEN z := z # v; END IF;
    IF get_bit(v, 127) = 1 THEN v := (v >> 1) # r; ELSE v := v >> 1; END IF;
  END LOOP;
  RETURN z;
END $fn$;

CREATE OR REPLACE FUNCTION vault._pad16(b bytea) RETURNS bytea
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT b || decode(repeat('00', (16 - length(b) % 16) % 16), 'hex')
$fn$;

CREATE OR REPLACE FUNCTION vault._ghash(h bit(128), aad bytea, data bytea) RETURNS bit(128)
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  msg bytea := vault._pad16(aad) || vault._pad16(data)
    || int8send(length(aad)::bigint * 8) || int8send(length(data)::bigint * 8);
  y bit(128) := B'0'::bit(128);
BEGIN
  FOR i IN 0..(length(msg) / 16 - 1) LOOP
    y := vault._gmul(y # vault._bits(substring(msg FROM i * 16 + 1 FOR 16)), h);
  END LOOP;
  RETURN y;
END $fn$;

-- CTR from inc32(J0): the first data block's counter is nonce || 2.
CREATE OR REPLACE FUNCTION vault._ctr(key bytea, nonce bytea, data bytea) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  out bytea := ''::bytea;
  ks bytea;
  chunk bytea;
BEGIN
  FOR i IN 0..((length(data) + 15) / 16 - 1) LOOP
    ks := vault._block(key, nonce || int4send(i + 2));
    chunk := substring(data FROM i * 16 + 1 FOR 16);
    FOR j IN 0..length(chunk) - 1 LOOP
      chunk := set_byte(chunk, j, get_byte(chunk, j) # get_byte(ks, j));
    END LOOP;
    out := out || chunk;
  END LOOP;
  RETURN out;
END $fn$;

CREATE OR REPLACE FUNCTION vault._tag(key bytea, nonce bytea, aad bytea, data bytea) RETURNS bytea
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT vault._bytes(
    vault._ghash(vault._bits(vault._block(key, decode(repeat('00', 16), 'hex'))), aad, data)
    # vault._bits(vault._block(key, nonce || int4send(1))))
$fn$;

CREATE OR REPLACE FUNCTION vault._seal(key bytea, id uuid, plain text, nonce bytea) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  c bytea := vault._ctr(key, nonce, convert_to(plain, 'UTF8'));
BEGIN
  RETURN translate(
    encode(c || vault._tag(key, nonce, convert_to(id::text, 'UTF8'), c), 'base64'),
    E'\n', '');
END $fn$;

CREATE OR REPLACE FUNCTION vault._open(key bytea, id uuid, secret text, nonce bytea) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
  sealed bytea;
  c bytea;
BEGIN
  IF nonce IS NULL OR length(nonce) <> 12 THEN RETURN NULL; END IF;
  sealed := decode(secret, 'base64');
  IF length(sealed) < 16 THEN RETURN NULL; END IF;
  c := substring(sealed FROM 1 FOR length(sealed) - 16);
  IF vault._tag(key, nonce, convert_to(id::text, 'UTF8'), c)
    <> substring(sealed FROM length(sealed) - 15) THEN
    RETURN NULL;
  END IF;
  RETURN convert_from(vault._ctr(key, nonce, c), 'UTF8');
EXCEPTION WHEN data_exception OR character_not_in_repertoire THEN
  RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION vault._decrypt(id uuid, secret text, nonce bytea, key_id uuid)
RETURNS text LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  k jsonb;
  plain text;
BEGIN
  FOR k IN SELECT * FROM jsonb_array_elements(vault._keys()) LOOP
    IF key_id IS NULL OR (k ->> 'id')::uuid = key_id THEN
      plain := vault._open(decode(k ->> 'key', 'hex'), id, secret, nonce);
      IF plain IS NOT NULL THEN RETURN plain; END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END $fn$;

CREATE OR REPLACE FUNCTION vault.create_secret(
  new_secret text,
  new_name text DEFAULT NULL,
  new_description text DEFAULT '',
  new_key_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE
  k jsonb := vault._key(new_key_id);
  new_id uuid := gen_random_uuid();
  new_nonce bytea := @pgcrypto@.gen_random_bytes(12);
BEGIN
  INSERT INTO vault.secrets (id, name, description, secret, key_id, nonce)
  VALUES (new_id, new_name, coalesce(new_description, ''),
    vault._seal(decode(k ->> 'key', 'hex'), new_id, new_secret, new_nonce), (k ->> 'id')::uuid,
    new_nonce);
  RETURN new_id;
END $fn$;

CREATE OR REPLACE FUNCTION vault.update_secret(
  secret_id uuid,
  new_secret text DEFAULT NULL,
  new_name text DEFAULT NULL,
  new_description text DEFAULT NULL,
  new_key_id uuid DEFAULT NULL
) RETURNS void LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE
  k jsonb;
  new_nonce bytea;
BEGIN
  UPDATE vault.secrets s SET
    name = coalesce(new_name, s.name),
    description = coalesce(new_description, s.description),
    updated_at = now()
  WHERE s.id = secret_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF new_secret IS NOT NULL OR new_key_id IS NOT NULL THEN
    k := vault._key(new_key_id);
    new_nonce := @pgcrypto@.gen_random_bytes(12);
    UPDATE vault.secrets s SET
      secret = vault._seal(decode(k ->> 'key', 'hex'), s.id,
        coalesce(new_secret, vault._decrypt(s.id, s.secret, s.nonce, s.key_id)), new_nonce),
      nonce = new_nonce,
      key_id = (k ->> 'id')::uuid
    WHERE s.id = secret_id;
  END IF;
END $fn$;

CREATE OR REPLACE VIEW vault.decrypted_secrets AS
  SELECT s.id, s.name, s.description, s.secret,
    vault._decrypt(s.id, s.secret, s.nonce, s.key_id) AS decrypted_secret,
    s.key_id, s.nonce, s.created_at, s.updated_at
  FROM vault.secrets s;
`;

/**
 * The SQL vault's migration, `backend_vault_sql_0001`: pgcrypto (created when missing — it is a
 * trusted extension), the functions qualified with pgcrypto's schema and pinned to an empty
 * search path, and nothing for `PUBLIC`, `anon` or `authenticated`: only the app's own database
 * user (the service role) can call them or read the view.
 *
 * @returns The migrations.
 */
export function vaultSqlMigrations(): Migration[] {
  return [{
    name: "backend_vault_sql_0001",
    sql: `CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $vault$
DECLARE
  crypto text := (SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
                  WHERE e.extname = 'pgcrypto');
  f record;
BEGIN
  EXECUTE replace(${dollar(FUNCTIONS)}, '@pgcrypto@', quote_ident(crypto));
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'vault' AND p.proname IN ('_keys', '_key', '_bits', '_bytes',
             '_block', '_gmul', '_pad16', '_ghash', '_ctr', '_tag', '_seal', '_open', '_decrypt',
             'create_secret', 'update_secret') LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, pg_temp', f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
  END LOOP;
  REVOKE ALL ON vault.decrypted_secrets FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON vault.decrypted_secrets FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON vault.decrypted_secrets FROM authenticated';
  END IF;
END $vault$;`,
  }];
}

/** `text` as a dollar-quoted literal whose tag does not occur inside it. */
function dollar(text: string): string {
  let tag = "vaultfn";
  while (text.includes(`$${tag}$`)) tag += "_";
  return `$${tag}$${text}$${tag}$`;
}
