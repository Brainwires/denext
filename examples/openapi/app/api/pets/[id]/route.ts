import { defineApi } from "denext/server";
import { Adoption, Pet, PetId } from "../../../../lib/schema.ts";
import { getPet, removePet, setAdopted } from "../../../../lib/store.ts";
import { authed } from "../../../../lib/auth.ts";

// Reads are public; writes require the bearer token — again decided per endpoint.

export const GET = defineApi(
  {
    summary: "Get one pet",
    security: [],
    params: PetId,
    response: Pet,
    errors: { not_found: 404 },
  },
  ({ params, fail }) => getPet(params.id) ?? fail("not_found"),
);

export const PATCH = authed.define(
  {
    summary: "Adopt or un-adopt a pet",
    security: [{ bearerAuth: [] }],
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
    security: [{ bearerAuth: [] }],
    params: PetId,
    errors: { not_found: 404 },
  },
  ({ params, fail }) => {
    if (!removePet(params.id)) fail("not_found");
    // Returning nothing is a 204.
  },
);
