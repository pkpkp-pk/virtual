"use client";

import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { onAuthChange, ensureAnonymousUser } from "@/lib/firebase/auth";
import {
  subscribeProfile,
  writeProfile,
  type TicketProfile,
} from "@/lib/firebase/profile";
import { clientConfigured } from "@/lib/firebase/client";

export interface AuthProfileState {
  ready: boolean;
  user: User | null;
  profile: TicketProfile | null;
  bind: (p: TicketProfile) => Promise<void>;
}

/** Signs in anonymously on mount and subscribes to the fan's ticket profile.
 *  No-op when Firebase isn't configured (dev). */
export function useAuthProfile(): AuthProfileState {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<TicketProfile | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!clientConfigured()) return;
    let unsubProfile: (() => void) | null = null;
    const unsubAuth = onAuthChange((u) => {
      setUser(u);
      if (unsubProfile) {
        unsubProfile();
        unsubProfile = null;
      }
      if (u) {
        unsubProfile = subscribeProfile(u.uid, setProfile);
      } else {
        setProfile(null);
      }
      setReady(true);
    });
    ensureAnonymousUser();
    return () => {
      unsubAuth();
      unsubProfile?.();
    };
  }, []);

  const bind = async (p: TicketProfile) => {
    if (user) await writeProfile(user.uid, p);
  };

  return { ready, user, profile, bind };
}
