import "dotenv/config";

import cors from "cors";
import express from "express";

import { loadEnv } from "./env.js";
import { registerCustomerRoutes } from "./routes/customers.js";
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

const env = loadEnv();

const app = express();
app.disable("x-powered-by");

app.use(
  cors({
    origin: true,
    credentials: true
  })
);
app.use(express.json());

const api = express.Router();
registerHealthRoutes(api);
registerCustomerRoutes(api);
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
app.use("/api", api);

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Backend listening on http://localhost:${env.PORT}`);
});

