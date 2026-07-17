// Firebase Cloud Messaging service worker for web push.
// Required so push notifications can be received when the app is backgrounded.
// The import is from the installed `firebase` package; the SW must be a plain
// JS file at the site root (Next serves everything in /public as-is).

import { initializeApp } from "firebase/app";
import { getMessaging } from "firebase/messaging/sw";

const firebaseConfig = {
  // NEXT_PUBLIC_* vars are NOT available to a service worker, so the config is
  // baked in at build time via the placeholder below. Replace with your real web
  // app config values (apiKey, authDomain, projectId, appId, messagingSenderId)
  // from the Firebase console, OR generate this file at build time from env.
  apiKey: "AIzaSyB-FGefc2zfwDX_sVaNrImA8gbVqkWk6ks",
  authDomain: "virtual-a0760.firebaseapp.com",
  projectId: "virtual-a0760",
  appId: "1:405331337231:web:740bfbd4e0ee3e4e36437a",
  messagingSenderId: "405331337231",
};

const app = initializeApp(firebaseConfig);
getMessaging(app);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
