import type { Router } from "express";

export function registerHealthRoutes(router: Router) {
  router.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "crm-backend",
      time: new Date().toISOString()
    });
  });
}

