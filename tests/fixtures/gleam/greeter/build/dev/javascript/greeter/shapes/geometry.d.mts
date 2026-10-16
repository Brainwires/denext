import type * as _ from "../gleam.d.mts";

export class Circle extends _.CustomType {
  /** @deprecated */
  constructor(radius: number);
  /** @deprecated */
  radius: number;
}
export function Shape$Circle(radius: number): Shape$;
export function Shape$isCircle(value: any): value is Shape$;
export function Shape$Circle$0(value: Shape$): number;
export function Shape$Circle$radius(value: Shape$): number;

export class Square extends _.CustomType {
  /** @deprecated */
  constructor(side: number);
  /** @deprecated */
  side: number;
}
export function Shape$Square(side: number): Shape$;
export function Shape$isSquare(value: any): value is Shape$;
export function Shape$Square$0(value: Shape$): number;
export function Shape$Square$side(value: Shape$): number;

export type Shape$ = Circle | Square;

export function area(shape: Shape$): number;
