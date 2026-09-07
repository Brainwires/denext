import { defineApi } from "denext/server";
import { ListQuery, NewPet, Pet, PetList } from "../../../lib/schema.ts";
import { addPet, listPets } from "../../../lib/store.ts";

// `defineApi`: `query` / `body` / `response` / `errors` are Standard Schemas. The handler gets
// PARSED, typed input; a schema mismatch is a structured 400 before it runs. `@denext/openapi`
// reads these definitions to build the document — the summary, the query parameter, the request
// body, and every response (200 + 400 + the declared error codes) appear in `/openapi.json`.

export const GET = defineApi(
  {
    summary: "List pets",
    query: ListQuery,
    response: PetList,
  },
  ({ query }) => listPets(query.species),
);

export const POST = defineApi(
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
