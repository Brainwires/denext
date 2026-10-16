// An on-demand job, scheduled from the config (`scheduledJobs` in the test's config).
declare function defineJob(job: unknown): unknown;
export default defineJob({ handler: () => {} });
