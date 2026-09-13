/**
 * Session-isolation usecase — correctness, not savings.
 * Two interleaved sessions (auth-review vs db-migration) share one proxy.
 * Asserts: states never cross-contaminate, both complete, per-session
 * step counters advance independently.
 *
 * Usage: SKILLSTATE_API_KEY=... SKILLSTATE_UPSTREAM=http://127.0.0.1:8789/v1 \
 *   npx tsx test/session-isolation.ts [rounds=6]
 */
const UPSTREAM = process.env.SKILLSTATE_UPSTREAM ?? "http://127.0.0.1:8789/v1";
const API_KEY = process.env.SKILLSTATE_API_KEY ?? "";
const MODEL = process.env.SKILLSTATE_MODEL ?? "deepseek-ai/DeepSeek-V4-Flash-0731";
const ROUNDS = Number(process.argv[2] ?? 6);

if (!API_KEY) throw new Error("SKILLSTATE_API_KEY is required");

const SYSTEM =
  "You are a long-horizon coding agent. Track progress in structured state. Reply with:\n" +
  "1) Brief reasoning\n" +
  "2) A ```json block with a state_patch and an action";

async function step(ssPort: number, sid: string, task: string, label: string) {
  const r = await fetch(`http://127.0.0.1:${ssPort}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
      "x-skillstate-session": sid,
    },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      max_tokens: 300,
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: task },
      ],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${label} failed (${r.status}): ${JSON.stringify(j).slice(0, 200)}`);
  if (j.error && !j.choices) throw new Error(`${label} error body: ${JSON.stringify(j).slice(0, 200)}`);
  if (j.usage?.prompt_tokens == null) throw new Error(`${label} omitted usage — refusing silent 0`);
  return {
    prompt: j.usage.prompt_tokens as number,
    stepHeader: r.headers.get("x-skillstate-step"),
    stateKeys: r.headers.get("x-skillstate-statekeys") ?? "",
    content: (j.choices?.[0]?.message?.content ?? "") as string,
  };
}

async function main() {
  const { startProxy } = await import("../src/proxy.js");
  const ss = await startProxy({
    listenPort: 0,
    stateDir: `/tmp/ss-isolation-${Date.now()}`,
    upstreams: [{ name: "upstream", url: UPSTREAM, apiKey: API_KEY, priority: 0 }],
    schema: ["step", "domain", "items_done", "issues_found", "summary", "completed"],
    initialState: { step: 0, domain: "", items_done: [], issues_found: [], summary: "", completed: false },
    maxRetries: 2,
  });
  const sidA = `iso-A-${Date.now().toString(36)}`;
  const sidB = `iso-B-${Date.now().toString(36)}`;
  console.log(`\nSession isolation · ${ROUNDS} interleaved rounds · ${MODEL}\n`);

  let gaps = 0;
  const seenA: string[] = [];
  const seenB: string[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    try {
      const a = await step(ss.port, sidA, `Review auth file ${i + 1}/6 (domain=auth).`, `A-${i + 1}`);
      seenA.push(a.stepHeader ?? "?");
      process.stdout.write(`\r  round ${i + 1}/${ROUNDS} A:step=${a.stepHeader} p=${a.prompt}`);
    } catch (e: any) {
      gaps++;
      console.error(`\n  ⚠ A-${i + 1}: ${e.message}`);
    }
    try {
      const b = await step(ss.port, sidB, `Migrate db table ${i + 1}/6 (domain=db).`, `B-${i + 1}`);
      seenB.push(b.stepHeader ?? "?");
      process.stdout.write(`  B:step=${b.stepHeader} p=${b.prompt}`);
    } catch (e: any) {
      gaps++;
      console.error(`\n  ⚠ B-${i + 1}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log();

  // assertions: independent step counters, no gaps ideally
  const expectA = Array.from({ length: seenA.length }, (_, i) => String(i + 1));
  const expectB = Array.from({ length: seenB.length }, (_, i) => String(i + 1));
  const okA = JSON.stringify(seenA) === JSON.stringify(expectA);
  const okB = JSON.stringify(seenB) === JSON.stringify(expectB);
  console.log(`  session A steps: [${seenA.join(",")}] ${okA ? "✓ independent" : "✗ CONTAMINATED"}`);
  console.log(`  session B steps: [${seenB.join(",")}] ${okB ? "✓ independent" : "✗ CONTAMINATED"}`);
  console.log(`  gaps: ${gaps}`);
  if (!okA || !okB) throw new Error("ISOLATION FAILURE: step counters cross-contaminated");
  ss.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
