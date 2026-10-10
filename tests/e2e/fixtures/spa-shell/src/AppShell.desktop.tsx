// The desktop targets' shell (macos / windows / linux exports): a platform file beside AppShell.tsx.
import { Layout } from "./layout.tsx";

export default function AppShell(props: { placeholder: string }) {
  return (
    <Layout title="Composer (desktop)" marker="shell-desktop">
      <div className="notes" contentEditable data-denext-shell-key="notes" />
      <textarea
        className="composer"
        placeholder={props.placeholder}
        data-denext-shell-key="composer"
      />
    </Layout>
  );
}
