export const screenOptions = { title: "Item" };

export default async function Item({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p data-testid="item">Item page {id}</p>;
}
