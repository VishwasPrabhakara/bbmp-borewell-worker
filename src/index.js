import { neon } from "@neondatabase/serverless";
import { handleRequest } from "./router.js";
import { queueRefresh } from "./db/queries/admin.js";

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    const sql = neon(env.DATABASE_URL);
    ctx.waitUntil(
      queueRefresh(sql, env, `Scheduled 15-day refresh queued by cron ${controller.cron}`)
        .catch(error => console.error("Scheduled refresh failed", error))
    );
  }
};
