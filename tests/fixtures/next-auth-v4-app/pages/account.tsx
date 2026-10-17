import type { GetServerSideProps } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "../lib/auth";

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const session = await getServerSession(ctx.req, ctx.res, authOptions);
  if (!session) {
    return {
      redirect: { destination: "/api/auth/signin?callbackUrl=%2Faccount", permanent: false },
    };
  }
  return { props: { email: session.user?.email ?? "" } };
};

export default function Account({ email }: { email: string }) {
  return <p id="account">account of {email}</p>;
}
