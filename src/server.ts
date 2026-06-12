import "dotenv/config";

import cors from "cors";
import express from "express";

import { loadEnv } from "./env.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerCertificationRoutes } from "./routes/certifications.js";
import { registerMembershipRoutes } from "./routes/memberships.js";
import { registerPartnershipRoutes } from "./routes/partnerships.js";
import { registerInsuranceRoutes } from "./routes/insurance.js";
import { registerVendorRoutes } from "./routes/vendors.js";
import { registerBuyerRoutes } from "./routes/buyers.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerAlertRoutes } from "./routes/alerts.js";
import { registerClockRoutes } from "./routes/clock.js";
import { registerCalendarRoutes } from "./routes/calendar.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerCommentRoutes } from "./routes/comments.js";
import { registerQuotationRoutes } from "./routes/quotations.js";
import { registerHrRoutes } from "./routes/hr/index.js";
import { registerInvoiceRoutes } from "./routes/invoices.js";
import { registerAnnouncementRoutes } from "./routes/announcements.js";
import { registerKnowledgeBaseRoutes } from "./routes/knowledgebase.js";
import { registerReportRoutes } from "./routes/reports.js";
import { registerTimeLogRoutes } from "./routes/timelogs.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerLeadRoutes } from "./routes/leads.js";
import { registerContactRoutes } from "./routes/contacts.js";

const env = loadEnv();

const app = express();
app.disable("x-powered-by");

const extraOrigins = (process.env.EXTRA_CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);

function normalizeOrigin(origin: string) {
  return origin.replace(/\/+$/, "");
}

const allowedOrigins = new Set([
  normalizeOrigin(env.FRONTEND_ORIGIN),
  ...extraOrigins.map(normalizeOrigin),
]);

app.use(
  cors({
    origin(origin, callback) {
      // Allow same-origin / server-to-server requests with no Origin header
      if (!origin || allowedOrigins.has(normalizeOrigin(origin))) return callback(null, true);
      console.warn(`[CORS] Blocked origin: ${origin}. Allowed: ${[...allowedOrigins].join(", ")}`);
      // Do not pass an Error here — browsers treat failed CORS preflight as a network error
      callback(null, false);
    },
    credentials: true
  })
);
app.use(express.json({ limit: "2mb" }));

const api = express.Router();
registerHealthRoutes(api);
registerProjectRoutes(api);
registerCertificationRoutes(api);
registerMembershipRoutes(api);
registerPartnershipRoutes(api);
registerInsuranceRoutes(api);
registerVendorRoutes(api);
registerBuyerRoutes(api);
registerDocumentRoutes(api);
registerAlertRoutes(api);
registerClockRoutes(api);
registerCalendarRoutes(api);
registerDashboardRoutes(api);
registerUserRoutes(api);
registerTaskRoutes(api);
registerCommentRoutes(api);
registerQuotationRoutes(api);
registerHrRoutes(api);
registerInvoiceRoutes(api);
registerAnnouncementRoutes(api);
registerKnowledgeBaseRoutes(api);
registerReportRoutes(api);
registerTimeLogRoutes(api);
registerNotificationRoutes(api);
registerLeadRoutes(api);
registerContactRoutes(api);
app.use("/api", api);

// Global error handler — never leak stack traces to clients
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on http://localhost:${env.PORT}`);
});

