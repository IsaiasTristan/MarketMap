"use client";
import { useQuery } from "@tanstack/react-query";

export interface Me {
  email: string;
  role: "ADMIN" | "USER";
}

/**
 * Current user identity + role from `/api/me`. Cached for the session; drives
 * client-side gating of admin-only controls. Server endpoints enforce the same
 * rules — this is purely a UX convenience, never a security boundary.
 */
export function useMe() {
  return useQuery<Me>({
    queryKey: ["me"],
    queryFn: async () => {
      const r = await fetch("/api/me", { cache: "no-store" });
      if (!r.ok) throw new Error("Failed to load identity");
      return r.json();
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** True only once `/api/me` resolves with role ADMIN. */
export function useIsAdmin(): boolean {
  const { data } = useMe();
  return data?.role === "ADMIN";
}
