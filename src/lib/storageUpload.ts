import { createClient } from "@supabase/supabase-js";

export const DOCUMENTS_BUCKET = "documents";
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const FOLDER_RE =
  /^(tasks|projects|library|jobs|kb|quotation-vendor-quotes|quotes|certifications|invoices|uploads|documents)(\/[A-Za-z0-9._-]+)*$/;

let ensurePromise: Promise<void> | null = null;

async function doEnsureBucket() {
  const { data, error } = await supabase.storage.getBucket(DOCUMENTS_BUCKET);
  if (error || !data) {
    const { error: createErr } = await supabase.storage.createBucket(DOCUMENTS_BUCKET, {
      public: true,
      fileSizeLimit: MAX_UPLOAD_BYTES,
    });
    if (createErr && !/already exists/i.test(createErr.message || "")) {
      throw createErr;
    }
    return;
  }
  if (!data.public) {
    await supabase.storage.updateBucket(DOCUMENTS_BUCKET, {
      public: true,
      fileSizeLimit: MAX_UPLOAD_BYTES,
    });
  }
}

export function ensureDocumentsBucket() {
  if (!ensurePromise) {
    ensurePromise = doEnsureBucket().catch((err) => {
      ensurePromise = null;
      throw err;
    });
  }
  return ensurePromise;
}

export function sanitizeFolder(folder: string) {
  const cleaned = String(folder || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.\./g, "");
  if (FOLDER_RE.test(cleaned)) return cleaned;
  return "uploads";
}

export function sanitizeFileName(name: string) {
  const base = String(name || "file")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
  return base || "file";
}

export async function createSignedUpload(folder: string, fileName: string) {
  await ensureDocumentsBucket();
  const path = `${sanitizeFolder(folder)}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${sanitizeFileName(fileName)}`;
  const { data, error } = await supabase.storage.from(DOCUMENTS_BUCKET).createSignedUploadUrl(path);
  if (error || !data) {
    throw new Error(error?.message || "Could not create upload URL");
  }

  const { data: pub } = supabase.storage.from(DOCUMENTS_BUCKET).getPublicUrl(path);
  const { data: signed } = await supabase.storage.from(DOCUMENTS_BUCKET).createSignedUrl(path, 60 * 60 * 24 * 365);

  return {
    bucket: DOCUMENTS_BUCKET,
    path: data.path || path,
    token: data.token,
    signedUploadUrl: data.signedUrl,
    url: pub.publicUrl || signed?.signedUrl || "",
  };
}

export async function signedDownloadUrl(path: string) {
  await ensureDocumentsBucket();
  const clean = String(path || "").replace(/^\/+/, "");
  if (!clean || clean.includes("..")) {
    throw new Error("Invalid path");
  }
  const { data, error } = await supabase.storage.from(DOCUMENTS_BUCKET).createSignedUrl(clean, 60 * 60);
  if (error || !data?.signedUrl) {
    const { data: pub } = supabase.storage.from(DOCUMENTS_BUCKET).getPublicUrl(clean);
    if (pub.publicUrl) return pub.publicUrl;
    throw new Error(error?.message || "Could not resolve file URL");
  }
  return data.signedUrl;
}
