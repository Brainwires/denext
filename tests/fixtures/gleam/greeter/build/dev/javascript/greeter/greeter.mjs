/// <reference types="./greeter.d.mts" />
import { Ok, Error, Empty as $Empty, divideInt } from "./gleam.mjs";

export function greet(name) {
  return ("Hello, " + name) + "!";
}

export function count(xs) {
  if (xs instanceof $Empty) {
    return 0;
  } else {
    let rest = xs.tail;
    return 1 + count(rest);
  }
}

export function safe_div(a, b) {
  if (b === 0) {
    return new Error("division by zero");
  } else {
    return new Ok(divideInt(a, b));
  }
}
