import { defineCollection, defineContentConfig, glob } from "@denext/content-collections/config";
import { z } from "zod";

export default defineContentConfig({
  collections: {
    blog: defineCollection({
      loader: glob({ pattern: "**/*.md", base: "content/blog" }),
      schema: z.object({
        title: z.string(),
        date: z.string(),
        draft: z.boolean().default(false),
      }),
    }),
  },
});
