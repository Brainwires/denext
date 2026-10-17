// The app's Prisma client, as a Node app writes it: `denext migrate` repoints the import at
// the generated Deno client and injects the datasource's driver adapter.
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

/** Every post with its author, newest first. */
export function listPosts() {
  return prisma.post.findMany({ include: { author: true }, orderBy: { id: "desc" } });
}

/** Add a post by the first user (created on demand). */
export async function addPost(title: string) {
  const author = await prisma.user.upsert({
    where: { email: "web@example.com" },
    update: {},
    create: { email: "web@example.com", name: "Web" },
  });
  return prisma.post.create({ data: { title, authorId: author.id } });
}
