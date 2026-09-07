import { defineApi } from "denext/server";
import { Adoption, Pet, PetId } from "../../../../lib/schema.ts";
import { getPet, removePet, setAdopted } from "../../../../lib/store.ts";

// A path with a parameter and several methods — each becomes an operation under
// `/api/pets/{id}` in the document, with `id` as a path parameter and `not_found` as a 404.

export const GET = defineApi(
  {
    summary: "Get one pet",
    params: PetId,
    response: Pet,
    errors: { not_found: 404 },
  },
  ({ params, fail }) => getPet(params.id) ?? fail("not_found"),
);

export const PATCH = defineApi(
  {
    summary: "Adopt or un-adopt a pet",
    params: PetId,
    body: Adoption,
    response: Pet,
    errors: { not_found: 404 },
  },
  ({ params, body, fail }) => setAdopted(params.id, body.adopted) ?? fail("not_found"),
);

export const DELETE = defineApi(
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
