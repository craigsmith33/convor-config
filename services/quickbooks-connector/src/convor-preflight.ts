// Runs before the QuickBooks client module loads (it is the first import of the
// entry file), so everything here happens before Intuit's code reads the env.
import fs from "fs";
import path from "path";
import crypto from "crypto";

const KEYS = ["QUICKBOOKS_CLIENT_ID", "QUICKBOOKS_CLIENT_SECRET", "QUICKBOOKS_REFRESH_TOKEN", "QUICKBOOKS_REALM_ID"] as const;
const OTHER = ["MCP_SHARED_SECRET", "QUICKBOOKS_TOKEN_STORE_PATH"] as const;

// Values pasted into Railway can carry stray spaces or line breaks.
for (const k of [...KEYS, ...OTHER, "QUICKBOOKS_ENVIRONMENT"]) {
  if (typeof process.env[k] === "string") process.env[k] = process.env[k]!.trim();
}

export const missing: string[] = [...KEYS, ...OTHER].filter((k) => {
  const v = process.env[k] || "";
  return !v || /^PASTE_/i.test(v);
});

const env = process.env.QUICKBOOKS_ENVIRONMENT || "sandbox";
if (env !== "sandbox" && env !== "production") missing.push("QUICKBOOKS_ENVIRONMENT (must be sandbox or production)");
if ((process.env.MCP_SHARED_SECRET || "").length < 32) missing.push("MCP_SHARED_SECRET (too short)");

export const configured = missing.length === 0;

if (!configured) {
  // Intuit's client throws at import when these are empty; keep the process up
  // so the health check can explain what is missing instead of crash-looping.
  for (const k of KEYS) if (!process.env[k]) process.env[k] = "NOT_CONFIGURED";
  // Never touch the token store while unconfigured.
  process.env.QUICKBOOKS_TOKEN_STORE_PATH = "/tmp/qbo-unconfigured.env";
} else {
  const store = process.env.QUICKBOOKS_TOKEN_STORE_PATH!;
  if (!path.isAbsolute(store)) throw new Error("QUICKBOOKS_TOKEN_STORE_PATH must be absolute");
  fs.mkdirSync(path.dirname(store), { recursive: true });
  // The token store holds the newest (rotated) refresh token and overrides the
  // env value. When someone pastes NEW keys into Railway, the old store must be
  // discarded or it would keep overriding them. The seed fingerprint tells the
  // two cases apart: unchanged seed = keep the rotated token; new seed = reset.
  const seed = crypto
    .createHash("sha256")
    .update([process.env.QUICKBOOKS_CLIENT_ID, process.env.QUICKBOOKS_REALM_ID, process.env.QUICKBOOKS_REFRESH_TOKEN].join("|"))
    .digest("hex");
  const seedFile = store + ".seed";
  const previous = fs.existsSync(seedFile) ? fs.readFileSync(seedFile, "utf8").trim() : "";
  if (previous !== seed) {
    if (fs.existsSync(store)) fs.unlinkSync(store);
    fs.writeFileSync(seedFile, seed + "\n", { mode: 0o600 });
    console.log("[connector] New QuickBooks keys detected; using the refresh token from Railway variables.");
  } else {
    console.log("[connector] Using the saved (rotated) QuickBooks refresh token.");
  }
}
