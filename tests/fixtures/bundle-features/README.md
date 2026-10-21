# bundle-features

The positive half of the client-bundle guard in `tests/integration/build-smoke.test.ts`: an app
that uses every gated feature once, so each feature's runtime must be in its client output.
`examples/hello` (the negative half) uses none of them. Built only by that test.
