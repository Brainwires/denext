// A dynamic segment with generateStaticParams: static.
export function generateStaticParams() {
  return [{ slug: "hello" }];
}
export default function Post({ params }: { params: { slug: string } }) {
  return <h1>{params.slug}</h1>;
}
