/**
 * SnapTrade client — the single construction point for the SnapTrade SDK.
 *
 * SnapTrade is the brokerage aggregator behind Engine "brokerage sync". It
 * exposes Robinhood (and 35+ other brokers) through one signed REST API; the
 * Robinhood integration is read-only by construction (no trading), which is
 * exactly the scope this feature needs.
 *
 * Mirrors the role `fmp-client.ts` plays for FMP: it owns the credential
 * wiring so no service ever touches the raw env vars or the auth handshake.
 *
 * We use SnapTrade **Personal** API-key auth (the `PERS-` key issued at
 * signup). A personal key is bound to exactly one auto-provisioned SnapTrade
 * user, so `registerUser`/`userSecret` do not apply — the key itself is the
 * credential, and account/position calls take only an `accountId`. The SDK
 * signs every request; we never hand-roll the signature.
 */
import { Snaptrade, SnaptradeAuth } from "snaptrade-typescript-sdk";
import { snaptradeClientId, snaptradeConsumerKey } from "@/infrastructure/config/env";

/** SnapTrade client specialized to personal API-key auth. */
type SnapClient = Snaptrade<ReturnType<typeof SnaptradeAuth.personalApiKey>>;

let client: SnapClient | null = null;

/** Raised when SnapTrade credentials are missing — callers fail loudly. */
export class SnapTradeNotConfiguredError extends Error {
  constructor() {
    super(
      "SnapTrade is not configured. Set SNAPTRADE_CLIENT_ID and SNAPTRADE_CONSUMER_KEY.",
    );
    this.name = "SnapTradeNotConfiguredError";
  }
}

/**
 * Lazily construct (and memoize) the SnapTrade SDK client. Throws
 * {@link SnapTradeNotConfiguredError} when credentials are absent so the API
 * layer can return a clean 501 instead of a cryptic SDK error.
 */
export function getSnapTradeClient(): SnapClient {
  if (client) return client;
  const clientId = snaptradeClientId();
  const consumerKey = snaptradeConsumerKey();
  if (!clientId || !consumerKey) throw new SnapTradeNotConfiguredError();
  client = new Snaptrade({
    auth: SnaptradeAuth.personalApiKey({ clientId, consumerKey }),
  });
  return client;
}
