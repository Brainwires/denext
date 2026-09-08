// Zod schemas. Zod ≥ 4.2 implements Standard JSON Schema, so `@denext/openapi` describes each
// parameter, request body, and response IN FULL in the generated document (a hand-rolled
// Standard Schema without a JSON-Schema export would show up as `{}` plus a lint warning).

import { z } from "zod";

const Species = z.enum(["cat", "dog", "bird"]);

export const Pet = z.object({
  id: z.string(),
  name: z.string(),
  species: Species,
  adopted: z.boolean(),
});

export const NewPet = z.object({
  name: z.string().min(1),
  species: Species,
});

export const PetId = z.object({ id: z.string() });

export const ListQuery = z.object({ species: Species.optional() });

export const Adoption = z.object({ adopted: z.boolean() });

export const PetList = z.array(Pet);
