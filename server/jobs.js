// Bounded in-memory job store for long image requests. Nothing is persisted:
// a process restart forgets every job, and the client is told to paint again.
import { randomUUID } from 'node:crypto';

export function createJobStore({ maxJobs = 20, ttlMs = 600_000, now = Date.now } = {}) {
  const jobs = new Map();
  const prune = () => { const time = now(); for (const [id, job] of jobs) if (job.expiresAt <= time) jobs.delete(id); };
  return {
    get size() { prune(); return jobs.size; },
    get(id) { prune(); return jobs.get(id) || null; },
    create(run) {
      prune();
      if (jobs.size >= maxJobs) throw Object.assign(new Error('Too many arenas are being painted right now. Try again in a few minutes.'), { status: 429, retryAfter: 60 });
      const job = { id: randomUUID(), status: 'queued', createdAt: now(), expiresAt: now() + ttlMs, result: null, error: null };
      jobs.set(job.id, job);
      Promise.resolve().then(() => { job.status = 'painting'; return run(); }).then(
        result => { job.status = 'done'; job.result = result; job.expiresAt = now() + ttlMs; },
        error => { job.status = 'failed'; job.error = { status: error?.status || 500, message: error?.status ? error.message : 'Arena painting failed. Your preset arena is unchanged.' }; job.expiresAt = now() + ttlMs; }
      );
      return job;
    }
  };
}
