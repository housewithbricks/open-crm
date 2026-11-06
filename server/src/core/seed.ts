import { sql } from "../db.js";
import { createObjectType, invalidateSchema, loadSchema } from "./schema.js";
import type { Actor } from "./types.js";

const system: Actor = { type: "user", name: "system", scopes: ["read", "write", "schema"] };

/** Seed the starter objects on first boot. Everything here is editable afterwards. */
export async function seed() {
  if ((await loadSchema()).length) return;
  console.log("[seed] creating starter objects");

  await createObjectType(system, {
    slug: "companies",
    label: "Company",
    label_plural: "Companies",
    icon: "building",
    color: "blue",
    description: "Organizations you work with: customers, prospects, partners.",
    fields: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "domain", label: "Domain", type: "url", unique: true, description: "Primary web domain, e.g. acme.com. Used to dedupe." },
      { key: "industry", label: "Industry", type: "select", choices: ["SaaS", "Agency", "E-commerce", "Finance", "Healthcare", "Other"] },
      { key: "size", label: "Size", type: "select", choices: ["1-10", "11-50", "51-200", "201-1000", "1000+"] },
      { key: "location", label: "Location", type: "text" },
      { key: "linkedin", label: "LinkedIn", type: "url" },
    ],
  });

  await createObjectType(system, {
    slug: "people",
    label: "Person",
    label_plural: "People",
    icon: "user",
    color: "violet",
    description: "Individual contacts.",
    fields: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "email", label: "Email", type: "email", unique: true, description: "Used to dedupe people." },
      { key: "phone", label: "Phone", type: "phone" },
      { key: "title", label: "Job title", type: "text" },
      { key: "company", label: "Company", type: "relation", target: "companies" },
      { key: "status", label: "Status", type: "select", choices: ["Lead", "Active", "Customer", "Partner", "Cold"] },
      { key: "linkedin", label: "LinkedIn", type: "url" },
      { key: "tags", label: "Tags", type: "multi_select", choices: ["Warm intro", "Investor", "Decision maker", "Champion"] },
    ],
  });

  await createObjectType(system, {
    slug: "deals",
    label: "Deal",
    label_plural: "Deals",
    icon: "handshake",
    color: "green",
    description: "Opportunities moving through your pipeline. Board view groups by stage.",
    fields: [
      { key: "name", label: "Name", type: "text", required: true },
      { key: "company", label: "Company", type: "relation", target: "companies" },
      { key: "contact", label: "Primary contact", type: "relation", target: "people" },
      {
        key: "stage",
        label: "Stage",
        type: "select",
        description: "Pipeline stage.",
        // Edit these from the board ("Edit stages"): order, names, colors, win probability, won/lost.
        choices: [
          { label: "Lead", color: "gray", kind: "open", probability: 10 },
          { label: "Qualified", color: "blue", kind: "open", probability: 25 },
          { label: "Proposal", color: "violet", kind: "open", probability: 50 },
          { label: "Negotiation", color: "amber", kind: "open", probability: 75 },
          { label: "Won", color: "green", kind: "won", probability: 100 },
          { label: "Lost", color: "red", kind: "lost", probability: 0 },
        ],
      },
      { key: "amount", label: "Amount", type: "currency", currency: "USD" },
      { key: "close_date", label: "Expected close", type: "date" },
      { key: "next_step", label: "Next step", type: "text" },
    ],
  });

  await sql`update object_types set is_system = true`;
  await sql`update field_defs set is_system = true`;
  invalidateSchema();
}
