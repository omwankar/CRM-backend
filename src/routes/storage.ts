import express from "express";
import { authMiddleware } from "../middleware/auth.js";
import { createSignedUpload, signedDownloadUrl } from "../lib/storageUpload.js";

const router = express.Router();

router.use(authMiddleware);

router.post("/signed-upload", async (req, res) => {
  try {
    const folder = String(req.body?.folder || "uploads");
    const fileName = String(req.body?.file_name || "file");
    const result = await createSignedUpload(folder, fileName);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload URL failed";
    console.error("[storage] signed-upload", message);
    res.status(500).json({ error: "Could not start file upload. Please try again." });
  }
});

router.get("/url", async (req, res) => {
  try {
    const path = String(req.query.path || "");
    if (!path) return res.status(400).json({ error: "path is required" });
    const url = await signedDownloadUrl(path);
    res.json({ url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not resolve file";
    res.status(400).json({ error: message });
  }
});

export function registerStorageRoutes(api: express.Router) {
  api.use("/storage", router);
}
