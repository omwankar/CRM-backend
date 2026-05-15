import express from "express";
import type { Router } from "express";
import { registerHrEmployeeRoutes } from "./employees.js";
import { registerHrLeaveRoutes } from "./leaves.js";
import { registerHrAttendanceRoutes } from "./attendance.js";
import { registerHrHolidayRoutes } from "./holidays.js";
import { registerHrAppreciationRoutes } from "./appreciations.js";

export function registerHrRoutes(api: Router) {
  const hr = express.Router();
  registerHrEmployeeRoutes(hr);
  registerHrLeaveRoutes(hr);
  registerHrAttendanceRoutes(hr);
  registerHrHolidayRoutes(hr);
  registerHrAppreciationRoutes(hr);
  api.use("/hr", hr);
}
