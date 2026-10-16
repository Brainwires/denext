// A scheduled job (the schedule is read as text).
declare function defineJob(job: unknown): unknown;
export default defineJob({
  description: "purge expired sessions",
  schedule: "0 3 * * *",
  handler: () => {},
});
