import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Pool } from "pg";
import type { MockPaymentProvider } from "./integrations/mockProvider.js";
import { getRefundContext, resolveRefund } from "./services/refundService.js";
import * as repo from "./db/repo.js";
import { centsToUsd, dollarsToCents } from "./domain/money.js";
import type { ConditionResult } from "./domain/refund.js";

function renderConditions(conditions: ConditionResult[]): string {
  if (conditions.length === 0) return "  (conditions not re-evaluated on idempotent replay)";
  return conditions.map((c) => `  [${c.passed ? "PASS" : "FAIL"}] ${c.code}: ${c.detail}`).join("\n");
}

/**
 * Builds a fresh MCP server with the commerce-operations tools registered.
 * The Postgres pool and payment provider are injected so the same builder is
 * used by the running server and by tests.
 */
export function buildMcpServer(pool: Pool, provider: MockPaymentProvider): McpServer {
  const server = new McpServer({ name: "commerce-ops-mcp", version: "1.0.0" });

  // -----------------------------------------------------------------------
  // Tool 1 (read): investigate an order and preview the refund decision.
  // -----------------------------------------------------------------------
  server.registerTool(
    "get_refund_context",
    {
      title: "Get refund context",
      description:
        "Read-only. Gathers everything needed to decide a carrier-exception refund for one order: " +
        "captured amount, amount already refunded, order age in days, customer risk score, whether a " +
        "carrier exception is verified, and whether a prior refund exists. Also returns a PREVIEW of the " +
        "policy outcome (auto_refund or escalate) and the pass/fail of each condition, WITHOUT taking any " +
        "action or moving money. Call this first to investigate before resolving a refund.",
      inputSchema: {
        orderId: z.string().describe("The order ID to investigate, e.g. 'ORD-1001'."),
        amount: z
          .number()
          .positive()
          .optional()
          .describe("Optional refund amount in US dollars to preview. Defaults to the remaining refundable balance."),
      },
    },
    async ({ orderId, amount }) => {
      const amountCents = amount !== undefined ? dollarsToCents(amount) : undefined;
      const ctx = await getRefundContext(pool, orderId, amountCents);
      if (!ctx.found) {
        return { isError: true, content: [{ type: "text", text: `Order ${orderId} not found.` }] };
      }
      const text = [
        `Order ${ctx.orderId}`,
        `  Captured (paid):        ${centsToUsd(ctx.capturedAmountCents)}`,
        `  Already refunded:       ${centsToUsd(ctx.priorRefundedCents)}`,
        `  Refund amount previewed:${" "}${centsToUsd(ctx.requestedAmountCents)}`,
        `  Order age:              ${ctx.orderAgeDays} day(s)`,
        `  Customer risk score:    ${ctx.customerRiskScore}`,
        `  Carrier exception:      ${ctx.carrierExceptionVerified ? "verified" : "not verified"}`,
        `  Exact refund exists:    ${ctx.hasExistingRefund ? "yes" : "no"}`,
        ``,
        `Policy preview: ${ctx.preview.outcome.toUpperCase()}`,
        renderConditions(ctx.preview.conditions),
        ``,
        ctx.preview.outcome === "auto_refund"
          ? "All conditions pass. resolve_refund would auto-execute the refund."
          : `Would ESCALATE for manager approval. Failing: ${ctx.preview.failed.join(", ")}.`,
      ].join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  // -----------------------------------------------------------------------
  // Tool 2 (write): resolve a refund — auto-execute or escalate.
  // -----------------------------------------------------------------------
  server.registerTool(
    "resolve_refund",
    {
      title: "Resolve a carrier-exception refund",
      description:
        "Resolves a carrier-exception refund for an order. Evaluates the six-condition auto-approval policy " +
        "(amount <= $150, cumulative refunds <= captured amount, order <= 30 days old, customer risk < 70, " +
        "carrier exception verified, no duplicate refund). If ALL conditions pass it executes a refund through " +
        "the payment provider; if ANY fails it creates a manager-approval escalation and NO money moves. " +
        "Safe to retry: pass the SAME idempotencyKey to retry the same logical request (it will not refund " +
        "twice); use a NEW unique idempotencyKey only for a genuinely different request.",
      inputSchema: {
        orderId: z.string().describe("The order ID to refund, e.g. 'ORD-1001'."),
        amount: z
          .number()
          .positive()
          .optional()
          .describe("Refund amount in US dollars. Defaults to the remaining refundable balance."),
        reason: z.string().min(1).describe("Short human-readable reason, e.g. 'Package confirmed lost by carrier'."),
        idempotencyKey: z
          .string()
          .min(1)
          .describe("Stable unique key identifying THIS logical refund request. Reuse to safely retry; use a new key only for a different request."),
      },
    },
    async ({ orderId, amount, reason, idempotencyKey }) => {
      let amountCents: number;
      if (amount !== undefined) {
        amountCents = dollarsToCents(amount);
      } else {
        const ctx = await getRefundContext(pool, orderId);
        if (!ctx.found) {
          return { isError: true, content: [{ type: "text", text: `Order ${orderId} not found.` }] };
        }
        amountCents = ctx.requestedAmountCents;
      }

      const result = await resolveRefund(pool, provider, { orderId, amountCents, reason, idempotencyKey });

      if (result.status === "order_not_found") {
        return { isError: true, content: [{ type: "text", text: `Order ${orderId} not found.` }] };
      }
      if (result.status === "refunded") {
        const text = [
          result.replayed
            ? "REFUND (idempotent replay): already processed; returning the original result."
            : "REFUND EXECUTED.",
          `  Order:            ${result.orderId}`,
          `  Amount:           ${centsToUsd(result.amountCents)}`,
          `  Refund ID:        ${result.refundId}`,
          `  Provider refund:  ${result.providerRefundId}`,
          result.orderStatus ? `  Order status:     ${result.orderStatus}` : "",
          ``,
          `Conditions:`,
          renderConditions(result.conditions),
        ].filter(Boolean).join("\n");
        return { content: [{ type: "text", text }] };
      }
      // escalated
      const text = [
        result.replayed
          ? "ESCALATION (idempotent replay): already escalated; returning the original result."
          : "ESCALATED for manager approval. No money moved.",
        `  Order:            ${result.orderId}`,
        `  Requested amount: ${centsToUsd(result.requestedAmountCents)}`,
        `  Escalation ID:    ${result.escalationId}`,
        `  Failing conditions: ${result.failed.join(", ")}`,
        ``,
        `Conditions:`,
        renderConditions(result.conditions),
      ].join("\n");
      return { content: [{ type: "text", text }] };
    },
  );

  // -----------------------------------------------------------------------
  // Tool 3 (read): list open manager-approval escalations.
  // -----------------------------------------------------------------------
  server.registerTool(
    "list_escalations",
    {
      title: "List open escalations",
      description:
        "Read-only. Lists open manager-approval escalations (refund requests that failed automatic approval), " +
        "newest first, each with the order, requested amount, and the conditions that failed. Use this to " +
        "review what is waiting for a human decision.",
      inputSchema: {
        limit: z.number().int().positive().max(200).optional().describe("Max escalations to return (default 50)."),
      },
    },
    async ({ limit }) => {
      const rows = await repo.listOpenEscalations(pool, limit ?? 50);
      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No open escalations." }] };
      }
      const text = rows
        .map(
          (r) =>
            `${r.id}  ${r.order_id}  ${centsToUsd(Number(r.requested_amount_cents))}  ` +
            `failed: ${(r.reason_codes as string[]).join(", ")}  (${r.created_at.toISOString()})`,
        )
        .join("\n");
      return { content: [{ type: "text", text: `Open escalations (${rows.length}):\n${text}` }] };
    },
  );

  return server;
}
