/// <reference types="./geometry.d.mts" />
import { CustomType as $CustomType } from "../gleam.mjs";

export class Circle extends $CustomType {
  constructor(radius) {
    super();
    this.radius = radius;
  }
}
export const Shape$Circle = (radius) => new Circle(radius);
export const Shape$isCircle = (value) => value instanceof Circle;
export const Shape$Circle$radius = (value) => value.radius;
export const Shape$Circle$0 = (value) => value.radius;

export class Square extends $CustomType {
  constructor(side) {
    super();
    this.side = side;
  }
}
export const Shape$Square = (side) => new Square(side);
export const Shape$isSquare = (value) => value instanceof Square;
export const Shape$Square$side = (value) => value.side;
export const Shape$Square$0 = (value) => value.side;

export function area(shape) {
  if (shape instanceof Circle) {
    let r = shape.radius;
    return (3.0 * r) * r;
  } else {
    let s = shape.side;
    return s * s;
  }
}
