import type { BenchList } from "../../../shared/data.ts";
import type { ListHandle } from "../bench.ts";

/** What every list impl receives. It renders `list` and registers its handle. */
export interface ImplProps {
  list: BenchList;
  handleRef: { current: ListHandle | null };
}
