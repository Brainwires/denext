// The docs index (`/docs`): every guide, grouped as the sidebar groups them. Generated from the
// same NAV the sidebar renders, so a new page shows up here without a second list to keep.
import { DocsShell, NAV } from "../../components/ui.tsx";

export const metadata = {
  title: "Documentation",
  description:
    "Every denext guide, from getting started to shipping one codebase to the web, iOS, Android and the desktop.",
};

export default function DocsIndex() {
  return (
    <DocsShell
      active=""
      title="Documentation"
      lead="Write the app once, with the React and App Router APIs you know, and ship it to the web, iOS, Android, macOS, Windows and Linux. New here? Start with Getting started."
    >
      {NAV.map((section) => (
        <section key={section.group}>
          <h2 id={section.group.toLowerCase().replaceAll(" ", "-")}>{section.group}</h2>
          <ul>
            {section.items.map((item) => (
              <li key={item.slug}>
                <a href={`/docs/${item.slug}`}>{item.label}</a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </DocsShell>
  );
}
