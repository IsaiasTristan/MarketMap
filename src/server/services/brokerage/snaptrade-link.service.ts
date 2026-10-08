/**
 * snaptrade-link.service — user registration, the Connection Portal handshake,
 * and account discovery for the SnapTrade brokerage link.
 *
 * Boundary: this service owns everything that creates/reads the BrokerageLink
 * and BrokerageAccountLink rows and talks to SnapTrade's authentication +
 * account-listing endpoints. The mirror itself lives in
 * `snaptrade-sync.service`. Read-only throughout — SnapTrade's Robinhood
 * integration does not support trading.
 */
import { prisma } from "@/infrastructure/db/client";
import { createPortfolio } from "@/server/services/portfolio.service";
import { writeAuditLog } from "@/server/services/audit.service";
import { getSnapTradeClient } from "@/infrastructure/providers/snaptrade/client";

function detailFrom(data: unknown): string | null {
  if (!data) return null;
  if (typeof data === "string") return data;
  if (typeof data === "object") {
    const d = data as { detail?: string; code?: string };
    if (d.detail) return d.code ? `${d.detail} (code ${d.code})` : d.detail;
    return JSON.stringify(data);
  }
  return null;
}

function errMessage(e: unknown): string {
  if (e && typeof e === "object") {
    const anyE = e as {
      response?: { data?: unknown };
      responseBody?: unknown;
      message?: string;
    };
    // The SnapTrade SDK surfaces the JSON error body on `responseBody`; axios-
    // style errors use `response.data`. Prefer whichever carries the detail.
    return (
      detailFrom(anyE.responseBody) ??
      detailFrom(anyE.response?.data) ??
      anyE.message ??
      String(e)
    );
  }
  return String(e);
}

/**
 * Ensure the per-user BrokerageLink anchor exists and return its id. With a
 * personal key there is no remote registration — the row just associates our
 * app user with their connected accounts.
 */
export async function ensureBrokerageLink(appUserId: string): Promise<string> {
  const existing = await prisma.brokerageLink.findUnique({
    where: { userId: appUserId },
    select: { id: true },
  });
  if (existing) return existing.id;
  const link = await prisma.brokerageLink.create({
    data: { userId: appUserId, provider: "SNAPTRADE", status: "ACTIVE" },
  });
  await writeAuditLog("brokerage.link_created", { appUserId });
  return link.id;
}

/**
 * Generate a Connection Portal URL for the user to log into their brokerage.
 * `returnUrl` is where SnapTrade sends the browser back after connecting.
 * `reconnect` (a brokerageAuthorizationId) re-opens a broken connection.
 *
 * Read-only by request (`connectionType: "read"`); the personal key carries
 * the user identity, so no userId/userSecret is passed.
 */
export async function createConnectionPortalUrl(opts: {
  appUserId: string;
  returnUrl: string;
  reconnect?: string;
}): Promise<string> {
  await ensureBrokerageLink(opts.appUserId);
  const client = getSnapTradeClient();
  try {
    const resp = await client.authentication.loginSnapTradeUser({
      broker: "ROBINHOOD",
      customRedirect: opts.returnUrl,
      connectionType: "read",
      ...(opts.reconnect ? { reconnect: opts.reconnect } : {}),
    });
    const data = resp.data;
    if (data && typeof data === "object" && "redirectURI" in data) {
      const uri = (data as { redirectURI?: string }).redirectURI;
      if (uri) return uri;
    }
    throw new Error("SnapTrade did not return a Connection Portal URL.");
  } catch (e) {
    throw new Error(`SnapTrade connection portal failed: ${errMessage(e)}`);
  }
}

export interface DiscoveredAccount {
  accountLinkId: string;
  portfolioId: string;
  institutionName: string | null;
  accountMask: string | null;
  isNew: boolean;
}

/**
 * List the user's connected brokerage accounts and ensure each has a paired
 * managed portfolio + BrokerageAccountLink. Idempotent: existing links are
 * left untouched; new accounts get a fresh portfolio named for the account.
 */
export async function discoverAndLinkAccounts(appUserId: string): Promise<DiscoveredAccount[]> {
  const linkId = await ensureBrokerageLink(appUserId);
  const client = getSnapTradeClient();
  const resp = await client.accountInformation.listUserAccounts();
  const accounts = resp.data ?? [];

  const out: DiscoveredAccount[] = [];
  for (const acct of accounts) {
    if (!acct.id) continue;
    const existing = await prisma.brokerageAccountLink.findUnique({
      where: { snaptradeAccountId: acct.id },
    });
    const institutionName = acct.institution_name ?? null;
    const number = acct.number ?? null;
    const accountMask = number ? number.slice(-4) : null;

    if (existing) {
      // Keep authorization/institution metadata fresh in case it changed.
      await prisma.brokerageAccountLink.update({
        where: { id: existing.id },
        data: {
          brokerageAuthorizationId: acct.brokerage_authorization ?? existing.brokerageAuthorizationId,
          institutionName: institutionName ?? existing.institutionName,
          accountMask: accountMask ?? existing.accountMask,
        },
      });
      out.push({
        accountLinkId: existing.id,
        portfolioId: existing.portfolioId,
        institutionName: institutionName ?? existing.institutionName,
        accountMask: accountMask ?? existing.accountMask,
        isNew: false,
      });
      continue;
    }

    const portfolioName = buildPortfolioName(institutionName, acct.name, accountMask);
    const portfolio = await createPortfolio(prisma, portfolioName, appUserId);
    const link = await prisma.brokerageAccountLink.create({
      data: {
        brokerageLinkId: linkId,
        portfolioId: portfolio.id,
        snaptradeAccountId: acct.id,
        brokerageAuthorizationId: acct.brokerage_authorization ?? null,
        institutionName,
        accountMask,
      },
    });
    await writeAuditLog("brokerage.account_linked", {
      appUserId,
      snaptradeAccountId: acct.id,
      portfolioId: portfolio.id,
    });
    out.push({
      accountLinkId: link.id,
      portfolioId: portfolio.id,
      institutionName,
      accountMask,
      isNew: true,
    });
  }
  return out;
}

function buildPortfolioName(
  institution: string | null,
  name: string | null,
  mask: string | null,
): string {
  const base = name?.trim() || institution?.trim() || "Brokerage";
  const hasInstitution = institution && base.toLowerCase().includes(institution.toLowerCase());
  const label = hasInstitution || !institution ? base : `${institution} ${base}`;
  return mask ? `${label} (…${mask})` : label;
}

/**
 * Remove a managed-account link (scoped to the owning user). Leaves the
 * Portfolio and its mirrored positions in place as an ordinary editable
 * portfolio.
 */
export async function disconnectAccount(
  appUserId: string,
  accountLinkId: string,
): Promise<boolean> {
  const link = await prisma.brokerageAccountLink.findUnique({
    where: { id: accountLinkId },
    include: { brokerageLink: { select: { userId: true } } },
  });
  if (!link || link.brokerageLink.userId !== appUserId) return false;
  await prisma.brokerageAccountLink.delete({ where: { id: accountLinkId } });
  await writeAuditLog("brokerage.account_disconnected", { appUserId, accountLinkId });
  return true;
}
