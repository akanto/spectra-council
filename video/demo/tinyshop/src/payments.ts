import type { User } from "./auth.ts";

// Stand-in for a payment provider.
export async function charge(user: User, cents: number): Promise<string> {
  await Bun.sleep(50);
  return `ch_${user.id}_${cents}`;
}
