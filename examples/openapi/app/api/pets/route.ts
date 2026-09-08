import { defineApi } from "denext/server";
import { ListQuery, NewPet, Pet, PetList } from "../../../lib/schema.ts";
import { addPet, listPets } from "../../../lib/store.ts";
import { authed } from "../../../lib/auth.ts";

// Security is decided by which builder you use — no `security` on the definitions:
//   defineApi(...)    → public (no lock)
//   authed.define(...) → the bearer middleware ENFORCES the token AND documents the requirement
//                        (via documentsSecurity in lib/auth.ts), so the operation shows the lock.
// One declaration does both, and operations on the same path can differ.

// Public: listing needs no token.
export const GET = defineApi(
  {
    summary: "List pets",
    query: ListQuery,
    response: PetList,
  },
  ({ query }) => listPets(query.species),
);

// Protected: `authed` enforces the token and marks this operation secured in the document.
export const POST = authed.define(
  {
    summary: "Add a pet",
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
