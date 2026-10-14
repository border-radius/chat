import { createApi } from "./api.ts";
import { startApp } from "./app.ts";
import { createAuthStore, createClient } from "./pb.ts";

startApp({
  api: createApi(createClient(location.origin, createAuthStore(localStorage))),
  root: document.getElementById("app")!,
});

// The offline shell and installing the app (DESIGN.md §27).
void navigator.serviceWorker?.register("/sw.js");
