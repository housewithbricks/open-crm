/**
 * End-to-end tests: boots the real server against a throwaway database and
 * drives it through REST and MCP, the same way the UI and agents do.
 *
 * Needs a reachable Postgres. TEST_DATABASE_URL defaults to the local dev one;
 * the database "opencrm_test" is dropped and recreated on every run.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { after, before, describe, it } from "node:test";
import postgres from "postgres";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://opencrm:opencrm@localhost:5432/opencrm";
const TEST_DB = "opencrm_test";
const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const PASSWORD = "test-pass";

let server: ChildProcess;
let cookie = "";
let key = "";
let db: postgres.Sql; // direct access to the test database, to set up states the API won't create

async function rest(path: string, opts: { method?: string; body?: unknown; bearer?: string } = {}) {
  const res = await fetch(BASE + "/api" + path, {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers: {
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : { cookie }),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, headers: res.headers };
}

let rpcId = 0;
async function mcp(name: string, args: Record<string, unknown> = {}, bearer = key) {
  const res = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const body: any = await res.json();
  const r = body.result;
  const text = r.content[0].text;
  if (r.isError) return { error: text as string };
  return { data: JSON.parse(text) };
}

async function rpc(method: string, params: unknown = {}, bearer = key) {
  const res = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

before(async () => {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`);
  await admin.unsafe(`create database ${TEST_DB}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = "/" + TEST_DB;

  server = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: { ...process.env, DATABASE_URL: url.toString(), PORT: String(PORT), ADMIN_PASSWORD: PASSWORD, WEB_DIST: "/nonexistent", LOGIN_GLOBAL_MAX: "40", TRUSTED_PROXY_HOPS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout!.on("data", (d) => (log += d));
  server.stderr!.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(BASE + "/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
    if (i === 99) throw new Error("server did not start:\n" + log);
  }

  db = postgres(url.toString(), { max: 2, onnotice: () => {} });
  const login = await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie")!.split(";")[0];
  key = (await rest("/keys", { body: { name: "Claude", scopes: ["read", "write", "schema"] } })).data.key;
});

after(async () => {
  server?.kill();
  await db?.end();
});

async function signIn(headers: Record<string, string> = {}, password = PASSWORD) {
  const res = await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ password }) });
  return { status: res.status, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

const asCookie = (c: string) => fetch(BASE + "/api/schema", { headers: { cookie: c } }).then((r) => r.status);
const auditFor = async (target: string, action: string) =>
  ((await rest("/audit?limit=500")).data as any[]).find((a) => a.target_id === target && a.action === action);

describe("auth", () => {
  it("rejects a wrong password and anonymous API calls", async () => {
    const bad = await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "nope" }) });
    assert.equal(bad.status, 401);
    const anon = await fetch(BASE + "/api/schema");
    assert.equal(anon.status, 401);
  });

  it("marks the session cookie Secure only over HTTPS", async () => {
    const login = (headers: Record<string, string>) =>
      fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ password: PASSWORD }) });
    assert.ok(!/;\s*Secure/i.test((await login({})).headers.get("set-cookie")!), "plain HTTP: not Secure");
    assert.match((await login({ "x-forwarded-proto": "https" })).headers.get("set-cookie")!, /;\s*Secure/i, "behind an HTTPS proxy: Secure");
  });

    it("rejects MCP without a valid key", async () => {
    const r = await rpc("tools/list", {}, "ocrm_invalid");
    assert.equal(r.status, 401);
  });

  it("accepts the key as ?key= for URL-only clients", async () => {
    const res = await fetch(`${BASE}/mcp?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(res.status, 200);
    const bad = await fetch(`${BASE}/mcp?key=ocrm_nope`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(bad.status, 401);
  });

    it("limits tools to the key's scopes", async () => {
    const ro = (await rest("/keys", { body: { name: "Reader", scopes: ["read"] } })).data.key;
    const { body } = await rpc("tools/list", {}, ro);
    const names = body.result.tools.map((t: any) => t.name);
    assert.ok(names.includes("search"));
    assert.ok(!names.includes("create_record"));
    const write = await rest("/objects/people/records", { body: { name: "x" }, bearer: ro });
    assert.equal(write.status, 403);
  });
});

describe("records over MCP", () => {
  let companyId = "";

  it("seeds the starter schema", async () => {
    const { data } = await mcp("describe_schema");
    assert.deepEqual(data.map((o: any) => o.object).sort(), ["companies", "deals", "people"]);
  });

  it("upserts by a unique field without duplicating", async () => {
    const a = await mcp("upsert_record", { object: "companies", match_on: "domain", data: { name: "Acme", domain: "acme.com" } });
    const b = await mcp("upsert_record", { object: "companies", match_on: "domain", data: { domain: "ACME.com", industry: "SaaS" } });
    assert.equal(a.data.action, "created");
    assert.equal(b.data.action, "updated");
    assert.equal(b.data.record.id, a.data.record.id);
    assert.equal(b.data.record.data.domain, "acme.com", "match value is kept as stored");
    assert.equal(b.data.record.data.industry, "saas", "select labels are normalized to values");
    companyId = a.data.record.id;
  });

  it("returns errors an agent can act on", async () => {
    const unknown = await mcp("create_record", { object: "deals", data: { name: "x", colour: "red" } });
    assert.match(unknown.error!, /Unknown field.*Valid fields/);
    const badOpt = await mcp("create_record", { object: "deals", data: { name: "x", stage: "maybe" } });
    assert.match(badOpt.error!, /Valid: lead, qualified/);
    const dup = await mcp("create_record", { object: "companies", data: { name: "Acme 2", domain: "acme.com" } });
    assert.match(dup.error!, /already exists/);
  });

  it("filters, sorts and resolves relations", async () => {
    for (const [name, amount, stage] of [["A", 1000, "lead"], ["B", 50000, "proposal"], ["C", 20000, "won"]] as const) {
      await mcp("create_record", { object: "deals", data: { name, amount, stage, company: companyId } });
    }
    const { data } = await mcp("list_records", {
      object: "deals",
      filters: [{ field: "amount", op: "gte", value: 5000 }, { field: "stage", op: "in", value: ["Proposal", "won"] }],
      sort: "amount",
      dir: "desc",
    });
    assert.deepEqual(data.records.map((r: any) => r.display_name), ["B", "C"]);
    assert.equal(data.refs[companyId].display_name, "Acme");
  });

  it("shows backlinks and the timeline on get_record", async () => {
    await mcp("log_activity", { record_ids: [companyId], kind: "call", body: "Intro call" });
    const { data } = await mcp("get_record", { id: companyId });
    assert.equal(data.related.find((r: any) => r.object === "deals").records.length, 3);
    assert.ok(data.timeline.some((t: any) => t.kind === "call" && t.actor_name === "Claude"));
  });

  it("bulk upserts with relation names and reports row errors", async () => {
    const { data } = await mcp("bulk_upsert_records", {
      object: "people",
      match_on: "email",
      records: [
        { name: "Jane", email: "jane@acme.com", company: "Acme" },
        { name: "Bo", email: "bo@newco.io", company: "NewCo" },
        { name: "Bad", email: "not-an-email" },
      ],
    });
    assert.equal(data.created, 2);
    assert.equal(data.failed, 1);
    assert.equal(data.errors[0].row, 2);
    const companies = await mcp("list_records", { object: "companies", query: "NewCo" });
    assert.equal(companies.data.total, 1, "missing related record was created");
  });

  it("searches names and values, not field keys", async () => {
    const keyword = await mcp("search", { query: "domain" }); // a field key, not a value
    assert.equal(keyword.data.length, 0);
    const short = await mcp("search", { query: "ac" });
    assert.ok(short.data.every((r: any) => /ac/i.test(r.display_name)), "short queries match names only");
    assert.equal(short.data[0].display_name, "Acme", "name-prefix matches rank first");
    const byValue = await mcp("search", { query: "acme.com" });
    assert.ok(byValue.data.some((r: any) => r.display_name === "Acme"), "longer queries match field values");
  });

    it("links tasks and activities to records across objects", async () => {
    const person = (await mcp("upsert_record", { object: "people", match_on: "email", data: { name: "Linky", email: "linky@acme.com", company: companyId } })).data.record;
    const deal = (await mcp("create_record", { object: "deals", data: { name: "Linked deal", company: companyId } })).data;
    const task = await mcp("create_task", { title: "Send proposal", record_ids: [person.id, companyId, deal.id] });
    assert.deepEqual(task.data.links.map((l: any) => l.object), ["people", "companies", "deals"]);

    for (const id of [person.id, companyId, deal.id]) {
      const { data } = await mcp("get_record", { id });
      assert.ok(data.timeline.some((t: any) => t.title === "Send proposal"), "task shows on every linked record");
    }
    const forDeal = await mcp("list_tasks", { record_id: deal.id });
    assert.deepEqual(forDeal.data.map((t: any) => t.title), ["Send proposal"]);

    const relinked = await mcp("update_task", { task_id: task.data.id, record_ids: [deal.id] });
    assert.deepEqual(relinked.data.links.map((l: any) => l.id), [deal.id]);
    const personAfter = await mcp("get_record", { id: person.id });
    assert.ok(!personAfter.data.timeline.some((t: any) => t.title === "Send proposal"), "unlinked record no longer shows it");

    const bad = await mcp("create_task", { title: "x", record_ids: ["00000000-0000-0000-0000-000000000000"] });
    assert.match(bad.error!, /not found/);

    const meeting = await mcp("log_activity", { kind: "meeting", body: "Kickoff", record_ids: [person.id, deal.id] });
    assert.equal(meeting.data.links.length, 2);
  });

    it("stores date-only due dates at noon UTC", async () => {
    const { data } = await mcp("create_task", { title: "Follow up", due_at: "2026-11-09" });
    assert.equal(data.due_at, "2026-11-09T12:00:00.000Z");
  });
});

describe("schema evolution", () => {
  it("lets agents add objects and fields", async () => {
    const obj = await mcp("create_object_type", { label: "Investor", fields: [{ label: "Check size", type: "currency" }] });
    assert.equal(obj.data.object, "investors");
    assert.deepEqual(obj.data.fields.map((f: any) => f.key), ["name", "check_size"]);
    const f = await mcp("add_field", { object: "deals", label: "Competitor", type: "text" });
    assert.equal(f.data.created_by, "Claude");
  });

  it("queues destructive changes for approval; agents cannot approve", async () => {
    const r = await mcp("request_schema_change", { kind: "archive_field", object: "deals", field: "competitor", reason: "unused" });
    assert.equal(r.data.applied, false);
    const id = r.data.change_request.id;
    assert.equal((await rest(`/changes/${id}/approve`, { body: {}, bearer: key })).status, 403);
    assert.equal((await rest(`/changes/${id}/approve`, { body: {} })).status, 200);
    const schema = await mcp("describe_schema");
    assert.ok(!schema.data.find((o: any) => o.object === "deals").fields.some((f: any) => f.key === "competitor"));
  });
});

describe("undo", () => {
  it("reverts an agent edit, detects conflicts, and refuses twice", async () => {
    const rec = (await mcp("create_record", { object: "people", data: { name: "Undo Me", title: "CEO" } })).data;
    await mcp("update_record", { id: rec.id, data: { title: "Intern" } });
    const audit = (await rest("/audit?limit=50")).data;
    const entry = audit.find((a: any) => a.action === "record.update" && a.target_id === rec.id);
    assert.ok(entry.undoable);

    await rest(`/records/${rec.id}`, { method: "PATCH", body: { title: "CTO" } });
    const conflict = await rest(`/audit/${entry.id}/undo`, { body: {} });
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.data.details.conflict, ["title"]);

    assert.equal((await rest(`/audit/${entry.id}/undo`, { body: { force: true } })).status, 200);
    assert.equal((await rest(`/records/${rec.id}`)).data.record.data.title, "CEO");
    assert.equal((await rest(`/audit/${entry.id}/undo`, { body: {} })).status, 409);
  });

  it("restores an approved field archive", async () => {
    const audit = (await rest("/audit?limit=100")).data;
    const entry = audit.find((a: any) => a.action === "schema.archive_field");
    assert.equal((await rest(`/audit/${entry.id}/undo`, { body: {} })).status, 200);
    const schema = await mcp("describe_schema");
    assert.ok(schema.data.find((o: any) => o.object === "deals").fields.some((f: any) => f.key === "competitor"));
  });
});

describe("views, import, export", () => {
  it("saves a view that list_records can use", async () => {
    const v = await mcp("save_view", { object: "deals", name: "Big", filters: [{ field: "amount", op: "gte", value: 10000 }], sort: "amount", dir: "asc" });
    assert.equal(v.data.name, "Big");
    const { data } = await mcp("list_records", { object: "deals", view: "Big" });
    assert.deepEqual(data.records.map((r: any) => r.display_name), ["C", "B"]);
    const bad = await mcp("save_view", { object: "deals", name: "x", filters: [{ field: "nope", op: "eq", value: 1 }] });
    assert.match(bad.error!, /not found/);
  });

  it("imports CSV rows and adds missing options", async () => {
    const r = await rest("/objects/people/import", {
      body: { match_on: "email", add_missing_options: true, rows: [{ name: "Cy", email: "cy@x.io", status: "VIP", company: "Acme" }] },
    });
    assert.equal(r.data.created, 1);
    const schema = (await rest("/schema")).data;
    const status = schema.objects.find((o: any) => o.slug === "people").fields.find((f: any) => f.key === "status");
    assert.ok(status.options.choices.some((c: any) => c.label === "VIP"));
  });

  it("exports CSV with names for relations and labels for options", async () => {
    const r = await fetch(BASE + "/api/objects/people/export.csv", { headers: { cookie } });
    assert.match(r.headers.get("content-type")!, /text\/csv/);
    const text = await r.text();
    const cy = text.split("\r\n").find((l) => l.includes("cy@x.io"))!;
    assert.match(cy, /,Acme,VIP,/);
  });
});

describe("filters", () => {
  const iso = (days: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

  before(async () => {
    for (const [name, amount, stage, close] of [["F1", 5000, "lead", iso(-3)], ["F2", 25000, "proposal", iso(2)], ["F3", 60000, "won", iso(20)], ["F4", 40000, "negotiation", iso(45)]] as const) {
      await mcp("create_record", { object: "deals", data: { name, amount, stage, close_date: close } });
    }
  });
  const names = async (filters: unknown[]) =>
    (await mcp("list_records", { object: "deals", filters, sort: "name", dir: "asc", limit: 100 })).data.records.map((r: any) => r.display_name).filter((n: string) => /^F\d$/.test(n));

  it("supports between, not_in and relative dates", async () => {
    assert.deepEqual(await names([{ field: "amount", op: "between", value: [20000, 50000] }]), ["F2", "F4"]);
    assert.deepEqual(await names([{ field: "stage", op: "not_in", value: ["Won", "Lead"] }]), ["F2", "F4"]);
    assert.deepEqual(await names([{ field: "close_date", op: "lt", value: "today" }]), ["F1"]);
    assert.deepEqual(await names([{ field: "close_date", op: "between", value: ["today", "today+30"] }]), ["F2", "F3"]);
    assert.deepEqual(await names([{ field: "created_at", op: "gte", value: "today-1" }, { field: "amount", op: "gt", value: 50000 }]), ["F3"]);
  });

  it("explains bad filters", async () => {
    const r = await mcp("list_records", { object: "deals", filters: [{ field: "amount", op: "between", value: 5 }] });
    assert.match(r.error!, /between needs \[min, max\]/);
  });

  it("lets agents save, update and delete views; invalid filters are rejected at save", async () => {
    const v = (await mcp("save_view", { object: "deals", name: "Closing soon", filters: [{ field: "close_date", op: "between", value: ["today", "today+30"] }] })).data;
    assert.deepEqual((await mcp("list_records", { object: "deals", view: v.id })).data.records.map((r: any) => r.display_name).filter((n: string) => /^F/.test(n)).sort(), ["F2", "F3"]);
    const u = (await mcp("update_view", { view_id: v.id, name: "Closing in 60 days", filters: [{ field: "close_date", op: "between", value: ["today", "today+60"] }] })).data;
    assert.equal(u.name, "Closing in 60 days");
    assert.equal(u.config.filters[0].value[1], "today+60", "relative dates are stored as written");
    const bad = await mcp("save_view", { object: "deals", name: "Bad", filters: [{ field: "stage", op: "in", value: ["Nope"] }] });
    assert.match(bad.error!, /not an option/);
    assert.equal((await mcp("delete_view", { view_id: v.id })).data.deleted, true);
  });
});

describe("dashboard", () => {
  it("summarises pipeline, win rate, tasks and activity", async () => {
    const before = (await rest("/dashboard")).data;
    const won = (await mcp("create_record", { object: "deals", data: { name: "Dash won", amount: 7000, stage: "proposal" } })).data;
    const lost = (await mcp("create_record", { object: "deals", data: { name: "Dash lost", amount: 3000, stage: "proposal" } })).data;
    await mcp("update_record", { id: won.id, data: { stage: "Won" } });
    await mcp("update_record", { id: lost.id, data: { stage: "Lost" } });
    const d = (await rest("/dashboard")).data;
    assert.equal(d.pipeline.object, "deals");
    assert.equal(d.pipeline.won_90d - (before.pipeline?.won_90d ?? 0), 1);
    assert.equal(d.pipeline.lost_90d - (before.pipeline?.lost_90d ?? 0), 1);
    assert.ok(d.pipeline.win_rate_90d > 0 && d.pipeline.win_rate_90d < 1);
    assert.ok(d.pipeline.won_this_month.amount >= 7000);
    const wonStage = d.pipeline.stages.find((x: any) => x.value === "won");
    assert.equal(wonStage.kind, "won");
    const openSum = d.pipeline.stages.filter((x: any) => x.kind === "open").reduce((t: number, x: any) => t + x.amount, 0);
    assert.equal(d.pipeline.open.amount, openSum, "open total equals the sum of open stages");
    assert.equal(d.activity.length, 30);
    assert.ok(d.activity[29].agent > 0, "today's agent activity is counted");
    assert.ok(d.agents.some((a: any) => a.name === "Claude"));
    assert.equal(typeof d.tasks.open, "number");
    const o = await mcp("get_overview");
    assert.equal(o.data.pipeline.open.amount, d.pipeline.open.amount, "agents see the same numbers");
  });
});

describe("pipeline stages", () => {
  it("seeds stage kinds and probabilities, and lets agents rework the pipeline", async () => {
    const stage = (await rest("/schema")).data.objects.find((o: any) => o.slug === "deals").fields.find((f: any) => f.key === "stage");
    const won = stage.options.choices.find((c: any) => c.value === "won");
    assert.equal(won.kind, "won");
    assert.equal(stage.options.choices.find((c: any) => c.value === "proposal").probability, 50);

    const current = stage.options.choices.map((c: any) => ({ value: c.value, label: c.label, color: c.color, kind: c.kind, probability: c.probability }));
    const reordered = [current[0], { label: "Discovery", kind: "open", probability: 15, color: "#0ea5e9" }, ...current.slice(1)];
    const r = await mcp("update_field", { object: "deals", field: "stage", options: reordered });
    assert.ok(!r.error, r.error);
    assert.deepEqual(r.data.options.choices.slice(0, 3).map((c: any) => c.label), [current[0].label, "Discovery", current[1].label], "new stage lands where it was placed");
    const disc = r.data.options.choices.find((c: any) => c.label === "Discovery");
    assert.equal(disc.probability, 15);
    assert.equal(disc.color, "#0ea5e9");

    const bad = await mcp("update_field", { object: "deals", field: "stage", options: [...reordered.slice(0, 1).map((c: any) => ({ ...c, kind: "maybe" }))] });
    assert.ok(bad.error, "invalid kind or dropped options are rejected");
  });

  it("forecasts with stage probabilities and reports monthly wins and weekly new pipeline", async () => {
    const d = (await rest("/dashboard")).data.pipeline;
    const expected = d.stages.filter((s: any) => s.kind === "open").reduce((t: number, s: any) => t + s.amount * ((s.probability ?? 0) / 100), 0);
    assert.ok(Math.abs(d.weighted - expected) < 0.01);
    assert.equal(d.monthly.length, 6);
    assert.ok(d.monthly[5].won_n >= 1, "this month's wins are counted");
    assert.equal(d.weekly_created.length, 8);
    assert.ok(d.weekly_created[7].amount > 0, "this week's new deals are counted");
    assert.equal(typeof d.cycle_days, "number");
  });
});

describe("appearance", () => {
  it("saves theme and accent, validates input, and is user-only", async () => {
    assert.deepEqual((await rest("/settings")).data, { theme: "system", accent: "#4f46e5" });
    assert.equal((await rest("/settings", { method: "PATCH", body: { theme: "dark", accent: "#E11D48" } })).data.accent, "#e11d48");
    assert.equal((await rest("/settings", { method: "PATCH", body: { accent: "red" } })).status, 400);
    assert.equal((await rest("/settings", { method: "PATCH", body: { theme: "sepia" } })).status, 400);
    assert.equal((await rest("/settings", { method: "PATCH", body: { theme: "light" }, bearer: key })).status, 403);
  });

  it("assigns object colors and validates changes", async () => {
    const schema = (await rest("/schema")).data.objects;
    assert.ok(schema.every((o: any) => o.color), "every object has a color");
    assert.equal((await rest("/objects/people", { method: "PATCH", body: { color: "pink" } })).data.color, "pink");
    assert.equal((await rest("/objects/people", { method: "PATCH", body: { color: "#0EA5E9" } })).data.color, "#0ea5e9", "custom hex colors are allowed");
    assert.equal((await rest("/objects/people", { method: "PATCH", body: { color: "red; background:url(x)" } })).status, 400);
    assert.equal((await rest("/objects/people", { method: "PATCH", body: { color: "#12345" } })).status, 400);
    const obj = await mcp("create_object_type", { label: "Venue", color: "#ff8800" });
    assert.ok(obj.data, "agents can set a custom color");
  });

  it("recolors, renames and adds select options in one edit", async () => {
    const before = (await rest("/schema")).data.objects.find((o: any) => o.slug === "deals").fields.find((f: any) => f.key === "stage").options.choices;
    const base = [{ value: "lead", label: "New lead", color: "pink" }, { value: "qualified", label: "Qualified", color: "blue" }, { value: "proposal", label: "Proposal", color: "violet" },
                  { value: "negotiation", label: "Negotiation", color: "amber" }, { value: "won", label: "Won", color: "green" }];
    // Keep any stages earlier tests added; this test only removes "lost".
    const others = before.filter((c: any) => c.value !== "lost" && !base.some((b) => b.value === c.value));
    const r = await rest("/objects/deals/fields/stage", {
      method: "PATCH",
      body: {
        choices: [...base, ...others],
        remove_choices: ["lost"],
        add_choices: [{ label: "On hold", color: "gray" }, { label: "Paused", color: "#AA00FF" }, { label: "Bad", color: "url(javascript:x)" }],
      },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.options.choices.filter((c: any) => !others.some((o: any) => o.value === c.value)).map((c: any) => `${c.value}:${c.label}:${c.color}`),
      ["lead:New lead:pink", "qualified:Qualified:blue", "proposal:Proposal:violet", "negotiation:Negotiation:amber", "won:Won:green", "on_hold:On hold:gray", "paused:Paused:#aa00ff", "bad:Bad:violet"]);
  });
});

describe("webhooks", () => {
  it("delivers signed events", async () => {
    const { createServer } = await import("node:http");
    const { createHmac } = await import("node:crypto");
    const got: { event: string; sig: string; body: string }[] = [];
    const recv = createServer((req, res) => {
      let b = "";
      req.on("data", (d) => (b += d));
      req.on("end", () => {
        got.push({ event: req.headers["x-opencrm-event"] as string, sig: req.headers["x-opencrm-signature"] as string, body: b });
        res.end("ok");
      });
    }).listen(8798);
    try {
      const hook = (await rest("/webhooks", { body: { url: "http://localhost:8798/", events: ["record.created"] } })).data;
      await mcp("create_record", { object: "companies", data: { name: "Hooked" } });
      for (let i = 0; i < 50 && !got.length; i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(got.length, 1);
      assert.equal(got[0].event, "record.created");
      assert.equal(got[0].sig, "sha256=" + createHmac("sha256", hook.secret).update(got[0].body).digest("hex"));
      assert.equal(JSON.parse(got[0].body).actor.name, "Claude");
    } finally {
      recv.close();
    }
  });
});

describe("review fixes", () => {
  it("REST needs the read scope to read data", async () => {
    for (const scopes of [["write"], ["schema"]]) {
      const k = (await rest("/keys", { body: { name: `No read ${scopes[0]}`, scopes } })).data.key;
      const rec = (await rest("/objects/people/records", { body: { name: "Scoped" } })).data;
      for (const path of ["/objects/people/records", `/records/${rec.id}`, `/records/${rec.id}/timeline`, "/objects/people/export.csv", "/audit", "/changes",
                          "/dashboard", "/search?q=sco", "/schema", "/tasks", "/objects/people/views", "/objects/deals/groups?field=stage"]) {
        assert.equal((await rest(path, { bearer: k })).status, 403, `${scopes[0]}-only key reading ${path}`);
      }
      assert.equal((await rest("/me", { bearer: k })).status, 200, "a key can still identify itself");
    }
    const reader = (await rest("/keys", { body: { name: "Read only", scopes: ["read"] } })).data.key;
    assert.equal((await rest("/objects/people/records", { bearer: reader })).status, 200);
  });

  it("keeps both edits when different fields of one record are patched at once", async () => {
    const d = (await rest("/objects/deals/records", { body: { name: "Race" } })).data;
    const patches = [{ amount: 1234 }, { stage: "proposal" }, { close_date: "2027-01-02" }, { next_step: "Call" }];
    const results = await Promise.all(patches.map((body) => rest(`/records/${d.id}`, { method: "PATCH", body })));
    assert.ok(results.every((r) => r.status === 200));
    const got = (await rest(`/records/${d.id}`)).data.record.data;
    assert.deepEqual([got.amount, got.stage, got.close_date, got.next_step], [1234, "proposal", "2027-01-02", "Call"]);
    const updates = ((await rest("/audit?limit=500")).data as any[]).filter((a) => a.target_id === d.id && a.action === "record.update");
    assert.equal(updates.length, 4, "one audit entry per edit");
  });

  it("converts values on a type change, refuses unconvertible ones, and never 500s on stray values", async () => {
    await rest("/objects", { body: { label: "Gadget", fields: [
      { label: "Tag", type: "select", choices: [{ label: "Alpha", color: "pink" }, "Beta"] }, { label: "Size", type: "text" }, { label: "Junk", type: "text" }, { label: "Maker", type: "text" },
    ] } });
    const mk = (data: object) => rest("/objects/gadgets/records", { body: data }).then((r) => r.data);
    const g1 = await mk({ name: "G1", tag: "alpha", size: "12", junk: "abc", maker: "Big Co" });
    const g2 = await mk({ name: "G2", tag: "beta", size: "$1,500", junk: "7", maker: "big-co" });
    const g3 = await mk({ name: "G3", maker: "!!!" });

    // select → multi_select: scalars become lists, options keep their labels and colors.
    assert.equal((await rest("/objects/gadgets/fields/tag", { method: "PATCH", body: { type: "multi_select" } })).status, 200);
    assert.deepEqual((await rest(`/records/${g1.id}`)).data.record.data.tag, ["alpha"]);
    const tag = (await rest("/schema")).data.objects.find((o: any) => o.slug === "gadgets").fields.find((f: any) => f.key === "tag");
    assert.equal(tag.options.choices[0].color, "pink");

    // text → number with the same coercion as a normal write.
    assert.equal((await rest("/objects/gadgets/fields/size", { method: "PATCH", body: { type: "number" } })).status, 200);
    assert.equal((await rest(`/records/${g2.id}`)).data.record.data.size, 1500);

    // Unconvertible values: refused with counts, nothing changes.
    const bad = await rest("/objects/gadgets/fields/junk", { method: "PATCH", body: { type: "number" } });
    assert.equal(bad.status, 409);
    assert.match(bad.data.error, /1 of 2 values can't be converted/);
    assert.equal(bad.data.details.examples[0].id, g1.id);
    const junk = (await rest("/schema")).data.objects.find((o: any) => o.slug === "gadgets").fields.find((f: any) => f.key === "junk");
    assert.equal(junk.type, "text");
    assert.equal((await rest(`/records/${g2.id}`)).data.record.data.junk, "7");

    // Agents' type changes go through approval; a refused approval stays pending.
    const req = await mcp("request_schema_change", { kind: "change_field_type", object: "gadgets", field: "junk", type: "boolean", reason: "flags" });
    const decided = await rest(`/changes/${req.data.change_request.id}/approve`, { body: {} });
    assert.equal(decided.status, 409);
    assert.equal((await rest("/changes?status=pending")).data.some((c: any) => c.id === req.data.change_request.id), true);

    // text → select: every distinct value becomes an option, however many and however odd.
    assert.equal((await rest("/objects/gadgets/fields/maker", { method: "PATCH", body: { type: "select" } })).status, 200);
    const maker = (await rest("/schema")).data.objects.find((o: any) => o.slug === "gadgets").fields.find((f: any) => f.key === "maker");
    const values = maker.options.choices.map((c: any) => c.value);
    for (const g of [g1, g2, g3]) assert.ok(values.includes((await rest(`/records/${g.id}`)).data.record.data.maker), "stored value is an option");
    assert.equal((await rest(`/records/${g1.id}`)).data.record.data.maker, (await rest(`/records/${g2.id}`)).data.record.data.maker, '"Big Co" and "big-co" share an option');

    // A stray string in a number field (old data, manual edit) doesn't break sort, filters or the dashboard.
    const d = (await rest("/objects/deals/records", { body: { name: "Stray", amount: 5 } })).data;
    await db`update records set data = jsonb_set(data, '{amount}', '"n/a"') where id = ${d.id}`;
    assert.equal((await rest("/objects/deals/records?sort=amount&dir=desc")).status, 200);
    assert.equal((await rest(`/objects/deals/records?filters=${encodeURIComponent(JSON.stringify([{ field: "amount", op: "gt", value: 1 }]))}`)).status, 200);
    assert.equal((await rest("/dashboard")).status, 200);
    // And a scalar left in a multi-select doesn't break the export.
    await db`update records set data = jsonb_set(data, '{tag}', '"beta"') where id = ${g2.id}`;
    const csv = await fetch(BASE + "/api/objects/gadgets/export.csv", { headers: { cookie } });
    assert.equal(csv.status, 200);
    assert.match((await csv.text()).split("\r\n").find((l) => l.includes(g2.id))!, /,Beta,/);
  });

  it("enforces unique fields on restore, undo and concurrent creates", async () => {
    const a = (await rest("/objects/companies/records", { body: { name: "Uniq A", domain: "uniq.io" } })).data;
    await rest(`/records/${a.id}`, { method: "DELETE" });
    const b = (await rest("/objects/companies/records", { body: { name: "Uniq B", domain: "uniq.io" } })).data;
    assert.ok(b.id, "the domain is free while A is archived");
    const restore = await rest(`/records/${a.id}/restore`, { body: {} });
    assert.equal(restore.status, 409);
    assert.match(restore.data.error, /already exists/);
    const archive = await auditFor(a.id, "record.archive");
    assert.equal((await rest(`/audit/${archive.id}/undo`, { body: {} })).status, 409, "undo of the archive is refused too");

    const racers = await Promise.all(Array.from({ length: 6 }, (_, i) => rest("/objects/companies/records", { body: { name: `Racer ${i}`, domain: "race.io" } })));
    assert.deepEqual(racers.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409]);
    const ups = await Promise.all(Array.from({ length: 4 }, () => mcp("upsert_record", { object: "companies", match_on: "domain", data: { name: "Ups", domain: "ups.io" } })));
    assert.equal(ups.filter((u) => u.data?.action === "created").length, 1, "concurrent upserts create once");
  });

  it("undoes select option edits: labels, colors, order, kind and probability", async () => {
    await rest("/objects", { body: { label: "Pipe", fields: [{ label: "Step", type: "select", choices: [{ label: "One", color: "blue" }, { label: "Two", color: "green" }] }] } });
    const orig = (await rest("/schema")).data.objects.find((o: any) => o.slug === "pipes").fields.find((f: any) => f.key === "step");
    const r = await mcp("update_field", { object: "pipes", field: "step", options: [
      { value: "two", label: "Second", color: "red", kind: "won", probability: 90 }, { value: "one", label: "First", color: "#123456", kind: "open", probability: 20 },
    ] });
    assert.ok(!r.error, r.error);
    const entry = await auditFor(orig.id, "field.update");
    assert.ok(entry.before.choices && entry.after.choices, "options are snapshotted");
    assert.equal((await rest(`/audit/${entry.id}/undo`, { body: {} })).status, 200);
    const now = (await rest("/schema")).data.objects.find((o: any) => o.slug === "pipes").fields.find((f: any) => f.key === "step");
    assert.deepEqual(now.options.choices, orig.options.choices);

    // A later edit is a conflict unless forced.
    await mcp("update_field", { object: "pipes", field: "step", add_choices: ["Three"] });
    const add = ((await rest("/audit?limit=500")).data as any[]).filter((a) => a.target_id === orig.id && a.action === "field.update" && !a.undone_at)[0];
    await mcp("update_field", { object: "pipes", field: "step", options: [{ value: "one", label: "Uno" }, { value: "two", label: "Two" }, { value: "three", label: "Three" }] });
    const conflict = await rest(`/audit/${add.id}/undo`, { body: {} });
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.data.details.conflict, ["choices"]);
    assert.equal((await rest(`/audit/${add.id}/undo`, { body: { force: true } })).status, 200);
    const forced = (await rest("/schema")).data.objects.find((o: any) => o.slug === "pipes").fields.find((f: any) => f.key === "step");
    assert.deepEqual(forced.options.choices.map((c: any) => c.value), ["one", "two"]);
  });

  it("audits every activity edit, makes edits and deletes undoable, and keeps task tools to tasks", async () => {
    const person = (await rest("/objects/people/records", { body: { name: "Act Person" } })).data;
    const task = (await mcp("create_task", { title: "Old title", record_ids: [person.id], due_at: "2026-12-01" })).data;
    await rest(`/activities/${task.id}`, { method: "PATCH", body: { title: "New title", body: "Notes", due_at: "2026-12-05", done: true } });
    const upd = await auditFor(task.id, "activity.update");
    assert.deepEqual(Object.keys(upd.after).sort(), ["body", "done_at", "due_at", "kind", "title"]);
    assert.equal(upd.before.title, "Old title");
    assert.equal(upd.before.due_at, "2026-12-01T12:00:00.000Z");
    assert.equal(upd.before.done_at, null);
    assert.equal((await rest(`/audit/${upd.id}/undo`, { body: {} })).status, 200);
    const back = (await rest("/tasks?all=1")).data.find((t: any) => t.id === task.id);
    assert.deepEqual([back.title, back.body, back.due_at, back.done_at], ["Old title", "", "2026-12-01T12:00:00.000Z", null]);

    await rest(`/activities/${task.id}`, { method: "DELETE" });
    assert.ok(!(await rest("/tasks")).data.some((t: any) => t.id === task.id), "deleted tasks are hidden");
    assert.ok(!(await rest(`/records/${person.id}/timeline`)).data.some((t: any) => t.id === task.id), "and gone from the timeline");
    assert.equal((await rest(`/activities/${task.id}`, { method: "PATCH", body: { title: "x" } })).status, 404);
    const del = await auditFor(task.id, "activity.delete");
    assert.equal(del.before.title, "Old title");
    assert.equal((await rest(`/audit/${del.id}/undo`, { body: {} })).status, 200);
    assert.ok((await rest("/tasks")).data.some((t: any) => t.id === task.id), "undo brings it back");

    const note = (await mcp("log_activity", { kind: "note", body: "Just a note", record_ids: [person.id] })).data;
    assert.match((await mcp("complete_task", { task_id: note.id })).error!, /not a task/);
    assert.match((await mcp("update_task", { task_id: note.id, title: "x" })).error!, /not a task/);
    assert.equal((await rest("/tasks?all=1")).data.find((t: any) => t.id === note.id), undefined);
  });

  it("shows records in removed options and computes board totals on the server", async () => {
    const mk = (name: string, stage: string, amount: number) => rest("/objects/deals/records", { body: { name, stage, amount } });
    await rest("/objects/deals/fields/stage", { method: "PATCH", body: { add_choices: [{ label: "Pilot" }] } });
    await mk("Pilot 1", "pilot", 1000);
    await mk("Pilot 2", "pilot", 2500);
    await rest("/objects/deals/fields/stage", { method: "PATCH", body: { remove_choices: ["pilot"] } });

    const stage = (await rest("/dashboard")).data.pipeline.stages.find((s: any) => s.value === "pilot");
    assert.deepEqual([stage.count, stage.amount, stage.unknown, stage.label], [2, 3500, true, "pilot"]);
    const groups = (await rest("/objects/deals/groups?field=stage&sum=amount")).data.groups;
    const pilot = groups.find((g: any) => g.value === "pilot");
    assert.deepEqual([pilot.count, pilot.sum, pilot.known], [2, 3500, false]);
    const total = (await rest("/objects/deals/records?limit=1")).data.total;
    assert.equal(groups.reduce((t: number, g: any) => t + g.count, 0), total, "group counts cover every record, not just a page");
    const q = (await rest("/objects/deals/groups?field=stage&q=Pilot")).data.groups;
    assert.deepEqual(q.map((g: any) => g.count), [2], "groups honour the search");
  });

  it("escapes CSV cells that a spreadsheet would run as formulas", async () => {
    await rest("/objects/people/records", { body: { name: "=HYPERLINK(\"http://x\")", title: "+1 bad", phone: "-5" } });
    const text = await (await fetch(BASE + "/api/objects/people/export.csv", { headers: { cookie } })).text();
    const line = text.split("\r\n").find((l) => l.includes("HYPERLINK"))!;
    assert.ok(line.includes(`"'=HYPERLINK(""http://x"")"`), line);
    assert.ok(line.includes(",'-5,") && line.includes(",'+1 bad,"), line);
  });

  it("blocks link-local webhook targets and doesn't follow redirects", async () => {
    for (const url of ["http://169.254.169.254/latest/meta-data", "http://[fe80::1]/", "http://metadata.google.internal/"]) {
      const r = await rest("/webhooks", { body: { url } });
      assert.equal(r.status, 400, url);
      assert.match(r.data.error, /link-local/);
    }
    const { createServer } = await import("node:http");
    let followed = 0;
    const target = createServer((_q, res) => { followed++; res.end("ok"); }).listen(8796);
    const redirector = createServer((_q, res) => { res.writeHead(302, { location: "http://localhost:8796/" }); res.end(); }).listen(8797);
    try {
      const hook = (await rest("/webhooks", { body: { url: "http://localhost:8797/", events: ["record.created"] } })).data;
      const r = (await rest(`/webhooks/${hook.id}/test`, { body: {} })).data;
      assert.deepEqual([r.status, r.error, followed], [302, "HTTP 302", 0]);
      await rest(`/webhooks/${hook.id}`, { method: "DELETE" });
    } finally {
      target.close();
      redirector.close();
    }
  });
});

describe("sessions", () => {
  it("signs out everywhere", async () => {
    const a = (await signIn()).cookie;
    const b = (await signIn()).cookie;
    assert.equal(await asCookie(b), 200);
    assert.equal((await fetch(BASE + "/api/logout-all", { method: "POST", headers: { cookie: a } })).status, 200);
    assert.equal(await asCookie(a), 401);
    assert.equal(await asCookie(b), 401);
    assert.equal(await asCookie(cookie), 401, "including the suite's own session");
    assert.equal((await rest("/schema", { bearer: key })).status, 200, "API keys are not affected");
    cookie = (await signIn()).cookie;
    assert.equal(await asCookie(cookie), 200, "signing in again works");
    assert.equal((await rest("/logout-all", { body: {}, bearer: key })).status, 403, "agents can't do it");
  });

  it("ends sessions when the admin password changes", async () => {
    const { scryptSync, randomBytes } = await import("node:crypto");
    const [{ value: old }] = await db`select value from settings where key = 'admin_password'`;
    const salt = randomBytes(16).toString("hex");
    await db`update settings set value = ${db.json(`${salt}:${scryptSync("rotated", salt, 64).toString("hex")}`)} where key = 'admin_password'`;
    assert.equal(await asCookie(cookie), 401);
    assert.equal((await signIn({}, "rotated")).status, 200);
    await db`update settings set value = ${db.json(old)} where key = 'admin_password'`;
    assert.equal(await asCookie(cookie), 200, "back to the old password, the old session is valid again");
  });
});

// Keep last: it trips the global sign-in limit.
describe("login limiter", () => {
  it("keys on the proxy-added address, not one the client forged", async () => {
    for (let i = 0; i < 10; i++) assert.equal((await signIn({ "x-forwarded-for": `10.0.0.${i}, 9.9.9.9` }, "wrong")).status, 401);
    assert.equal((await signIn({ "x-forwarded-for": "1.2.3.4, 9.9.9.9" })).status, 429, "a forged left-most entry doesn't reset the count");
    assert.equal((await signIn({ "x-forwarded-for": "1.2.3.4, 8.8.8.8" })).status, 200, "other clients are unaffected");
  });

  it("caps failed sign-ins across all addresses", async () => {
    let last = 0;
    for (let i = 0; i < 40 && last !== 429; i++) last = (await signIn({ "x-forwarded-for": `7.7.7.${i}` }, "wrong")).status;
    assert.equal(last, 429);
    assert.equal((await signIn({ "x-forwarded-for": "6.6.6.6" })).status, 429, "even the right password waits");
    assert.equal(await asCookie(cookie), 200, "existing sessions keep working");
  });
});
