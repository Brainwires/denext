//// A counter with a note field, written once in Lustre and used three ways by the denext app:
//// as an island (`app`, its start as flags), as the custom element `<lustre-counter>`
//// (`component`, its start from the `start` attribute) and as a server component (`app` again,
//// run on the server by `defineLustreView`).

import gleam/int
import gleam/result
import lustre
import lustre/attribute
import lustre/component
import lustre/effect
import lustre/element.{type Element}
import lustre/element/html
import lustre/event

pub type Model {
  Model(count: Int, note: String)
}

pub type Msg {
  Incr
  Decr
  SetNote(String)
  SetCount(Int)
}

pub fn init(start: Int) -> Model {
  Model(count: start, note: "")
}

pub fn update(model: Model, msg: Msg) -> Model {
  case msg {
    Incr -> Model(..model, count: model.count + 1)
    Decr -> Model(..model, count: model.count - 1)
    SetNote(note) -> Model(..model, note:)
    SetCount(count) -> Model(..model, count:)
  }
}

pub fn view(model: Model) -> Element(Msg) {
  html.div([attribute.class("counter")], [
    html.button([attribute.class("dec"), event.on_click(Decr)], [html.text("-")]),
    html.span([attribute.class("count")], [html.text(int.to_string(model.count))]),
    html.button([attribute.class("inc"), event.on_click(Incr)], [html.text("+")]),
    html.input([
      attribute.class("note"),
      attribute.placeholder("a note"),
      attribute.value(model.note),
      event.on_input(SetNote),
    ]),
    html.output([attribute.class("echo")], [html.text(model.note)]),
  ])
}

/// The counter as an app: its flags are the starting count.
pub fn app() -> lustre.App(Int, Model, Msg) {
  lustre.simple(init, update, view)
}

/// The counter as a custom element: the `start` attribute sets the count.
pub fn component() -> lustre.App(Nil, Model, Msg) {
  lustre.component(
    fn(_) { #(init(0), effect.none()) },
    fn(model, msg) { #(update(model, msg), effect.none()) },
    view,
    [
      component.open_shadow_root(True),
      component.on_attribute_change("start", fn(value) {
        int.parse(value) |> result.map(SetCount)
      }),
    ],
  )
}
