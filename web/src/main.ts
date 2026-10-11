import { createApi } from "./api.ts";
import { startApp } from "./app.ts";
import { createAuthStore, createClient } from "./pb.ts";

startApp({
  api: createApi(createClient(location.origin, createAuthStore(localStorage))),
  root: document.getElementById("app")!,
});
