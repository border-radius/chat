import PocketBase from "pocketbase";
import { createApi } from "./api.ts";
import { startApp } from "./app.ts";

startApp({
  api: createApi(new PocketBase(location.origin)),
  root: document.getElementById("app")!,
});
