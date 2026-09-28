// Runs one piece of a task — until it finishes, pauses for the user, or
// reaches its time limit — with the same agent core as the local broker.
// Started asynchronously by the relay. Filled in by step 7 of the rollout;
// deployed now so the stack, its permissions and its 15-minute timeout are
// in place.

export async function handler(event: unknown): Promise<{ ok: boolean }> {
  console.log(`[agent] not built yet — got ${JSON.stringify(event).slice(0, 500)}`);
  return { ok: false };
}
