pub fn greet(name: String) -> String {
  "Hello, " <> name <> "!"
}

pub fn count(xs: List(a)) -> Int {
  case xs {
    [] -> 0
    [_, ..rest] -> 1 + count(rest)
  }
}

pub fn safe_div(a: Int, b: Int) -> Result(Int, String) {
  case b {
    0 -> Error("division by zero")
    _ -> Ok(a / b)
  }
}
