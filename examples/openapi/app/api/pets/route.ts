import { defineApi } from "denext/server";
import { ListQuery, NewPet, Pet, PetList } from "../../../lib/schema.ts";
import { addPet, listPets } from "../../../lib/store.ts";
import { authed } from "../../../lib/auth.ts";

// Security is declared PER ENDPOINT on the definition (`security`), so operations on the same
// path can differ: listing is public, adding requires a bearer token. `security` is DOCUMENTATION
// (the lock + Authorize button); enforcement is the `authed` middleware — the two are kept in
// sync here by writing both on the protected operation.

// Public: no token, no lock. `security: []` says "deliberately public" (overrides any default).
export const GET = defineApi(
  {
    summary: "List pets",
    security: [],
    query: ListQuery,
    response: PetList,
  },
  ({ query }) => listPets(query.species),
);

// Protected: `authed.define` enforces the token; `security` documents the requirement.
export const POST = authed.define(
  {
    summary: "Add a pet",
    security: [{ bearerAuth: [] }],
    body: NewPet,
    response: Pet,
    errors: { duplicate: 409 },
  },
  ({ body, fail }) => {
    if (listPets(body.species).some((p) => p.name === body.name)) {
      fail("duplicate", { message: `a ${body.species} named "${body.name}" already exists` });
    }
    return addPet(body);
  },
);
