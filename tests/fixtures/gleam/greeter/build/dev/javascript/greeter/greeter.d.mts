import type * as _ from "./gleam.d.mts";

export function greet(name: string): string;

export function count(xs: _.List<any>): number;

export function safe_div(a: number, b: number): _.Result<number, string>;
