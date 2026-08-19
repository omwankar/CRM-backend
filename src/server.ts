import "./loadEnvFile.js";

import cors from "cors";
import express from "express";

import { loadEnv } from "./env.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerCertificationRoutes } from "./routes/certifications.js";
import { registerMembershipRoutes } from "./routes/memberships.js";
import { registerPartnershipRoutes } from "./routes/partnerships.js";
import { registerInsuranceRoutes } from "./routes/insurance.js";
import { registerVendorRoutes } from "./routes/vendors.js";
import { registerBuyerRoutes } from "./routes/buyers.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerStorageRoutes } from "./routes/storage.js";
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
import { registerPaymentRoutes } from "./routes/payments.js";
import { registerCreditStatusRoutes } from "./routes/creditStatus.js";
import { registerAnnouncementRoutes } from "./routes/announcements.js";
import { registerKnowledgeBaseRoutes } from "./routes/knowledgebase.js";
import { registerReportRoutes } from "./routes/reports.js";
import { registerSalesReportRoutes } from "./routes/salesReports.js";
import { registerTimeLogRoutes } from "./routes/timelogs.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { registerLeadRoutes } from "./routes/leads.js";
import { registerEnquiryRoutes } from "./routes/enquiries.js";
import { registerOpportunityRoutes } from "./routes/opportunities.js";
import { registerCompanyRoutes } from "./routes/companies.js";
import { registerActivityRoutes } from "./routes/activities.js";
import { registerContactRoutes } from "./routes/contacts.js";
import { registerEmailRoutes, registerEmailSyncInternalRoute } from "./routes/emails.js";
import { startEmailSyncCron } from "./jobs/emailSyncCron.js";
import { startTaskOverdueCron } from "./jobs/taskOverdueCron.js";
import { startAnnouncementExpiryCron } from "./jobs/announcementExpiryCron.js";
import { startClockAutoClockOutCron } from "./jobs/clockAutoClockOutCron.js";
import { startClockOpenSessionWarningCron } from "./jobs/clockOpenSessionWarningCron.js";
import { startKeepAliveCron } from "./jobs/keepAliveCron.js";
import { isGraphConfigured, isGraphSendConfigured } from "./services/graphClient.js";

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
registerJobRoutes(api);
registerCertificationRoutes(api);
registerMembershipRoutes(api);
registerPartnershipRoutes(api);
registerInsuranceRoutes(api);
registerVendorRoutes(api);
registerBuyerRoutes(api);
registerDocumentRoutes(api);
registerStorageRoutes(api);
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
registerPaymentRoutes(api);
registerCreditStatusRoutes(api);
registerAnnouncementRoutes(api);
registerKnowledgeBaseRoutes(api);
registerReportRoutes(api);
registerSalesReportRoutes(api);
registerTimeLogRoutes(api);
registerNotificationRoutes(api);
registerLeadRoutes(api);
registerEnquiryRoutes(api);
registerOpportunityRoutes(api);
registerCompanyRoutes(api);
registerActivityRoutes(api);
registerContactRoutes(api);
registerEmailRoutes(api);
registerEmailSyncInternalRoute(api);
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
  console.log(
    `[graph] Microsoft 365 sync: ${isGraphConfigured() ? "configured" : "NOT configured — add MS_GRAPH_* to backend/.env and restart"}`,
  );
  console.log(
    `[graph] Outbound mail (quotations/invoices): ${isGraphSendConfigured() ? "configured" : "NOT configured — set MS_GRAPH_SEND_FROM_EMAIL in backend/.env"}`,
  );
  startEmailSyncCron();
  startTaskOverdueCron();
  startAnnouncementExpiryCron();
  startClockAutoClockOutCron();
  startClockOpenSessionWarningCron();
  startKeepAliveCron();
});

