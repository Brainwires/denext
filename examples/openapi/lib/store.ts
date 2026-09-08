// The demo's data: an in-memory list (a stand-in for a database). Server-only — imported by
// the route handlers, never by a client component.

export interface Pet {
  id: string;
  name: string;
  species: "cat" | "dog" | "bird";
  adopted: boolean;
}

const pets: Pet[] = [
  { id: "1", name: "Milo", species: "cat", adopted: false },
  { id: "2", name: "Rex", species: "dog", adopted: true },
];

export function listPets(species?: Pet["species"]): Pet[] {
  return species === undefined ? [...pets] : pets.filter((p) => p.species === species);
}

export function getPet(id: string): Pet | undefined {
  return pets.find((p) => p.id === id);
}

export function addPet(input: { name: string; species: Pet["species"] }): Pet {
  const pet: Pet = { id: String(pets.length + 1), adopted: false, ...input };
  pets.push(pet);
  return pet;
}

export function setAdopted(id: string, adopted: boolean): Pet | undefined {
  const pet = pets.find((p) => p.id === id);
  if (pet) pet.adopted = adopted;
  return pet;
}

export function removePet(id: string): boolean {
  const i = pets.findIndex((p) => p.id === id);
  if (i === -1) return false;
  pets.splice(i, 1);
  return true;
}
