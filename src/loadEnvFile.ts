import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Always load backend/.env regardless of process cwd (e.g. monorepo root).
dotenv.config({ path: path.join(backendRoot, ".env") });
