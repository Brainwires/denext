pub type Shape {
  Circle(radius: Float)
  Square(side: Float)
}

pub fn area(shape: Shape) -> Float {
  case shape {
    Circle(r) -> 3.0 *. r *. r
    Square(s) -> s *. s
  }
}
