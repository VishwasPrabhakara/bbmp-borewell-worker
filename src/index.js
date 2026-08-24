import { handleRequest } from "./router.js";

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    console.log(`Scheduled refresh ignored for ${controller.cron}; KH data now comes from uploaded Excel ZIPs only.`);
  }
};
