"use client";
import { Fragment, useState } from "denext";

export function PlainCounter() {
  const [n, setN] = useState(0);
  return (
    <Fragment>
      <button
        type="button"
        data-testid="plain-count"
        onClick={() => setN(n + 1)}
      >
        plain:{n}
      </button>
    </Fragment>
  );
}
