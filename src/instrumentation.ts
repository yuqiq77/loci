import { getServerEnv } from "@/server/env";
import { startJobWorker } from "@/server/jobs/worker";

export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    getServerEnv();
    startJobWorker();
  }
}
