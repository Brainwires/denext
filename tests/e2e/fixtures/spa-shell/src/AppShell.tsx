// The prerendered shell (web and every target without a variant): pure markup, no app runtime.
import { Layout } from "./layout.tsx";

export default function AppShell(props: { placeholder: string }) {
  return (
    <Layout title="Composer" marker="shell">
      <div className="notes" contentEditable data-denext-shell-key="notes" />
      <textarea
        className="composer"
        placeholder={props.placeholder}
        data-denext-shell-key="composer"
      />
    </Layout>
  );
}
