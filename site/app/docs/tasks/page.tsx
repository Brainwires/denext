// denext 4.0 renamed background and scheduled tasks to jobs, and this page to /docs/jobs. The site
// is a static export with no server redirects, so the old URL (linked from 3.x changelog entries
// and posts) keeps a page that sends the reader on.
import { DocsShell } from "../../../components/ui.tsx";

export const metadata = {
  title: "Moved: Scheduled & background jobs",
  description:
    "This page moved to /docs/jobs: denext 4.0 calls background and scheduled work jobs.",
};

export default function TasksMoved() {
  return (
    <DocsShell
      active="jobs"
      title="This page moved"
      lead="denext 4.0 calls background and scheduled work jobs."
    >
      <meta httpEquiv="refresh" content="0; url=/docs/jobs" />
      <p>
        Scheduled and background tasks are now{" "}
        <a href="/docs/jobs">
          Scheduled &amp; background jobs
        </a>. Where run history is kept is{" "}
        <a href="/docs/jobs#history-store">
          Where history is kept
        </a>; moving a 3.x app is in the <a href="/docs/changelog">changelog</a>.
      </p>
    </DocsShell>
  );
}
