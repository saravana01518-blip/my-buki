/**
 * One-time Sage OAuth2 authorization helper (`npm run sage:auth`).
 *
 * Prints the Sage Central authorize URL, listens on SAGE_CALLBACK_URL for the
 * callback `code`, exchanges it for access + refresh tokens, resolves the
 * business ID via GET /businesses, and persists tokens to .data/sage-tokens.json.
 */

import http from "node:http";
import { loadDotEnv } from "../../../../scripts/env.mjs";
import { SAGE_AUTHORIZE_URL, SageClient, configFromEnv } from "./client";

loadDotEnv();

async function main() {
  const cfg = configFromEnv();
  const callbackUrl = process.env.SAGE_CALLBACK_URL || "http://localhost:3000/api/sage/callback";
  if (!cfg.clientId || !cfg.clientSecret) {
    console.error("Error: SAGE_CLIENT_ID and SAGE_CLIENT_SECRET must be set in .env");
    process.exit(1);
  }

  const parsedCallback = new URL(callbackUrl);
  const port = Number(parsedCallback.port) || 3000;
  const authUrl = new URL(SAGE_AUTHORIZE_URL);
  authUrl.searchParams.set("client_id", cfg.clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", callbackUrl);
  authUrl.searchParams.set("scope", "full_access");
  authUrl.searchParams.set("country", "gb");

  console.log("\nOpen this URL in your browser to authorize Sage:\n");
  console.log(authUrl.toString());
  console.log(`\nListening for OAuth callback on ${callbackUrl} ...\n`);

  const client = new SageClient(cfg);

  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || "/", `http://localhost:${port}`);
      if (reqUrl.pathname !== parsedCallback.pathname) {
        res.writeHead(404).end("Not found");
        return;
      }
      const code = reqUrl.searchParams.get("code");
      if (!code) {
        res.writeHead(400).end("Missing ?code parameter");
        return;
      }
      await client.exchangeCode(code, callbackUrl);
      const businessId = await client.resolveBusinessId();
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`Sage authorization complete! Business ID: ${businessId}. You may close this tab.`);
      console.log(`Authorized! Business ID: ${businessId}. Tokens saved to .data/sage-tokens.json`);
      server.close();
      process.exit(0);
    } catch (err) {
      res.writeHead(500).end(err instanceof Error ? err.message : String(err));
      console.error("OAuth error:", err);
      server.close();
      process.exit(1);
    }
  });

  server.listen(port);
}

main();
