import type { Router } from "express";
import { isGraphConfigured, isGraphSendConfigured } from "../services/graphClient.js";

export function registerHealthRoutes(router: Router) {
  router.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "crm-backend",
      time: new Date().toISOString(),
      graph_configured: isGraphConfigured(),
      graph_send_configured: isGraphSendConfigured(),
    });
  });
}

