//// A ticker: an app whose effect starts a timer that dispatches `Tick` on an interval. Rendered as
//// an island that can be hidden, it shows that a stopped Lustre app takes no more messages: once
//// the island unmounts, the timer's dispatches never reach `update`.

import gleam/int
import lustre
import lustre/attribute
import lustre/effect.{type Effect}
import lustre/element.{type Element}
import lustre/element/html

pub type Model {
  Model(ticks: Int)
}

pub type Msg {
  Tick
}

fn init(every_ms: Int) -> #(Model, Effect(Msg)) {
  #(Model(ticks: 0), effect.from(fn(dispatch) { every(every_ms, fn() { dispatch(Tick) }) }))
}

fn update(model: Model, msg: Msg) -> #(Model, Effect(Msg)) {
  case msg {
    Tick -> #(Model(ticks: model.ticks + 1), effect.none())
  }
}

fn view(model: Model) -> Element(Msg) {
  html.p([attribute.class("ticker")], [
    html.text("ticks: "),
    html.span([attribute.class("ticks")], [html.text(int.to_string(model.ticks))]),
  ])
}

/// The ticker as an app: its flags are the interval in milliseconds.
pub fn app() -> lustre.App(Int, Model, Msg) {
  lustre.application(init, update, view)
}

@external(javascript, "./ticker.ffi.mjs", "every")
fn every(ms: Int, callback: fn() -> Nil) -> Nil
