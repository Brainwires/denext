import { defineApi } from "denext/server";
import { Adoption, Pet, PetId } from "../../../../lib/schema.ts";
import { getPet, removePet, setAdopted } from "../../../../lib/store.ts";
import { authed } from "../../../../lib/auth.ts";

// Reads are public (`defineApi`); writes are protected + auto-documented (`authed.define`).

export const GET = defineApi(
  {
    summary: "Get one pet",
    params: PetId,
    response: Pet,
    errors: { not_found: 404 },
  },
  ({ params, fail }) => getPet(params.id) ?? fail("not_found"),
);

export const PATCH = authed.define(
  {
    summary: "Adopt or un-adopt a pet",
    params: PetId,
    body: Adoption,
    response: Pet,
    errors: { not_found: 404 },
  },
  ({ params, body, fail }) => setAdopted(params.id, body.adopted) ?? fail("not_found"),
);

export const DELETE = authed.define(
  {
    summary: "Remove a pet",
    params: PetId,
    errors: { not_found: 404 },
  },
  ({ params, fail }) => {
    if (!removePet(params.id)) fail("not_found");
    // Returning nothing is a 204.
  },
);
