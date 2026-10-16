// A dynamic segment with no generateStaticParams: dynamic.
export default function User({ params }: { params: { id: string } }) {
  return <h1>{params.id}</h1>;
}
