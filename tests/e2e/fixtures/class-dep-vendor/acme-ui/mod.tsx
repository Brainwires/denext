// fallow-ignore-file unused-file -- a fixture template copied into place by the e2e, not imported.
// Stands in for an npm dependency: the e2e copies this file (kept OUTSIDE the fixture project,
// where the build's source scan would otherwise read it) to
// `node_modules/@acme/ui/mod.tsx` before building (node_modules is git-ignored, the app imports
// it by path because a bare alias in a nested fixture is invisible to the test process, and the
// build's class scan deliberately never reads it — exactly the "class hidden in a dependency"
// case). The app's own sources never say `Component`, so the build emits the LAZY entry and
// the class runtime must arrive through the `#__denext_classes` marker.
// Relative to the file's DESTINATION (class-dep/node_modules/@acme/ui/), not this template.
// fallow-ignore-next-line unresolved-import
import { Component } from "../../../../../../../src/compat/react.ts";

/** A class error boundary — decided by `hasErrorLifecycle` before any render. */
export class Boundary extends Component<{ children?: unknown }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render() {
    if (this.state.failed) {
      return <p data-testid="fallback">caught by a class boundary</p>;
    }
    return this.props.children as never;
  }
}

/** A stateful class: `setState` proves the lazily loaded runtime is wired to the scheduler. */
export class Counter extends Component<Record<never, never>, { n: number }> {
  override state = { n: 0 };
  override render() {
    return (
      <button
        type="button"
        data-testid="count"
        onClick={() => this.setState({ n: this.state.n + 1 })}
      >
        count:{this.state.n}
      </button>
    );
  }
}
