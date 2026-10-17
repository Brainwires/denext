import type { GetServerSideProps } from "next";
import { getCsrfToken, getSession } from "next-auth/react";

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getSession(ctx);
  const csrfToken = await getCsrfToken(ctx);
  return { props: { name: session?.user?.name ?? "nobody", hasCsrf: !!csrfToken } };
};

export default function Legacy({ name, hasCsrf }: { name: string; hasCsrf: boolean }) {
  return <p id="legacy">legacy {name} csrf {String(hasCsrf)}</p>;
}
